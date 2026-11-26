
'use strict';
const { swallow } = require('./failopen.js');

function makeExecutionRouter(deps) {
  deps = deps || {};
  const environments = deps.environments || {};
  const defaultBackendId = String(deps.defaultBackendId || 'local');
  const profileForAgent = typeof deps.profileForAgent === 'function'
    ? deps.profileForAgent
    : (() => 'station-gear');
  const forceLocalForAgent = typeof deps.forceLocalForAgent === 'function'
    ? deps.forceLocalForAgent
    : (() => false);

  if (!environments[defaultBackendId]) {
    throw new Error(
      'execution router missing default backend "' +
      defaultBackendId + '"'
    );
  }

  const envSrc = deps.env || process.env;

  // TEO gateway: disabled by default.
  // Do not enable until socket access is securely isolated.
  const teoGatewayEnabled =
    String(envSrc.STARNET_TEO_GATEWAY_ENABLED || '') === '1';

  const teoSocketPath = '/run/starnet-gateway.sock';

  function teoSocketReady() {
    try {
      return require('node:fs')
        .statSync(teoSocketPath)
        .isSocket();
    } catch (_) {
      return false;
    }
  }

  function teoUnavailable(operation) {
    const e = new Error(
      'TEO gateway: ' + operation +
      ' not available; local fallback is forbidden'
    );
    e.code = 'teo_gateway_unavailable';
    return e;
  }

  function makeTeoBackend() {
    const local = environments.local;

    if (!local) {
      throw teoUnavailable('local workspace bookkeeping');
    }

    const supports = Object.freeze({
      shell: true,
      background: false,
      hostWorkspace: false,
      workspaceSync: false,
      checkpoints: false,
      hostileCodeSandbox: false,
      persistentSession: false,
      stdioMcp: false
    });

    const denied = operation =>
      Promise.reject(teoUnavailable(operation));

    const denySync = operation => {
      throw teoUnavailable(operation);
    };

    // The host-side working directory is separate from StarNet's container paths.
    let remoteCwd = '/home/teo';

    const backgroundError = () => ({
      ok: false,
      error: 'TEO gateway: background operations are not supported'
    });

    return {
      id: 'teo-gateway',
      backendId: 'teo-gateway',
      supports,

      describe: () => ({
        backend: 'teo-gateway',
        workspace: '/home/teo',
        background: false,
        availability: {
          state: teoSocketReady() ? 'ready' : 'unavailable'
        },
        supports
      }),

      ensureReady: async agentId => {
        if (
          String(agentId) !== 'engineer' ||
          !teoSocketReady()
        ) {
          throw teoUnavailable('socket');
        }

        return {
          ok: true,
          backend: 'teo-gateway'
        };
      },

      cleanupAgent: () => Promise.resolve({
        ok: false,
        error: 'TEO gateway does not manage disposable environments'
      }),

      invalidateAgent: () => ({ ok: true }),

      // These methods manage StarNet workspace metadata only.
      // Commands are not executed through the local backend.
      workspaceRoot: agentId => local.workspaceRoot(agentId),

      ensureWorkspace: agentId => local.ensureWorkspace(agentId),

      getCwd: agentId => local.getCwd(agentId),

      rememberCwd: (agentId, cwd) => {
        if (String(agentId) !== 'engineer' ||
            typeof cwd !== 'string' ||
            !cwd.startsWith('/') ||
            cwd.length > 4096 ||
            /[\x00\r\n]/.test(cwd)) {
          throw teoUnavailable('rememberCwd');
        }
        // The path comes from the nonce-marked shell result on Contabo.
        // Never use it as a path inside the StarNet application container.
        remoteCwd = cwd;
        return { ok: true };
      },

      commandEnv: () => null,

      execute: opts => {
        if (
          !opts ||
          opts.agentId !== 'engineer' ||
          !teoSocketReady()
        ) {
          return denied('execute');
        }

        if (
          opts.breakaway ||
          opts.input != null
        ) {
          return denied(
            'execution options (breakaway/input)'
          );
        }

        // shell.exec sends a container-side cwd and an AbortSignal by default.
        // Do not interpret either as permission to execute locally.
        if (opts.signal && opts.signal.aborted) {
          return denied('aborted before execution');
        }
        if (typeof opts.cmd !== 'string') {
          return denied('invalid command');
        }

        // The command runs on Contabo, as the unprivileged teo user.
        // CWD from StarNet is a CONTAINER path; use only the remote cwd.
        const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
        const command = 'cd -- ' + quote(remoteCwd) + ' || exit 1\n' + opts.cmd;
        const started = Date.now();

        return require('./teo-gateway.js')
          .execute(command, 'engineer')
          .then(result => {
            const fullOut =
              result.stdout + result.stderr;

            const requestedMax = Number(opts.maxBytes);

            const cap =
              Number.isFinite(requestedMax) &&
              requestedMax > 0
                ? Math.min(requestedMax, 150000)
                : 150000;

            return {
              exitCode: result.exit_code,
              out: fullOut.slice(0, cap),
              fullOut,
              fullOutElided: 0,
              ms: Date.now() - started,
              truncated: fullOut.length > cap,
              timedOut: false,
              aborted: false
            };
          });
      },

      // Unsupported operations must never fall back to local.
      startBackground: () => denied('startBackground'),

      statusBackground: (agentId, bgId) =>
        bgId ? null : [],

      readBackground: backgroundError,
      writeBackground: backgroundError,
      closeBackgroundStdin: backgroundError,
      killBackground: backgroundError,

      waitBackground: () => null,
      killAllBackground: () => 0,

      spawnStdio: () => denySync('spawnStdio'),

      syncWorkspace: () => denied('syncWorkspace'),

      createCheckpoint: () => denied('createCheckpoint'),
      listCheckpoints: () => denied('listCheckpoints'),
      restoreCheckpoint: () => denied('restoreCheckpoint')
    };
  }

  let teoBackend = null;

  const fallbackPolicy = String(
    deps.sandboxFallback ||
    envSrc.STARNET_SANDBOX_FALLBACK ||
    envSrc.SKYNET_SANDBOX_FALLBACK ||
    'refuse'
  ).trim().toLowerCase() === 'allow'
    ? 'allow'
    : 'refuse';

  function availabilityOf(backendId, agentId) {
    const env = environments[backendId];

    if (!env) {
      return {
        state: 'absent',
        error: null
      };
    }

    try {
      const d = env.describe(agentId) || {};
      const a = d.availability || {};

      return {
        state: String(a.state || 'unknown'),
        error: a.error ? String(a.error) : null
      };
    } catch (_) {
      return {
        state: 'unknown',
        error: null
      };
    }
  }

  const UNUSABLE = {
    absent: true,
    unavailable: true,
    'configuration-required': true
  };

  function resolveBackend(profileId, agentId) {
    profileId = String(profileId || 'station-gear');

    const want =
      profileId === 'safe-cell'
        ? 'docker'
        : profileId === 'remote-ssh'
          ? 'ssh'
          : (
            profileId === 'trusted-project' ||
            profileId === 'this-computer'
          )
            ? 'local'
            : defaultBackendId;

    const avail = availabilityOf(want, agentId);

    if (!UNUSABLE[avail.state]) {
      return {
        id: want,
        requested: want,
        matched: true,
        reason: null,
        profileId,
        availability: avail.state
      };
    }

    const reason =
      avail.state === 'absent'
        ? (
          want === 'docker'
            ? 'Docker is not available on this machine'
            : want === 'ssh'
              ? 'no SSH execution backend is configured'
              : 'the ' + want +
                ' execution backend is not registered'
        )
        : avail.state === 'configuration-required'
          ? 'no SSH target is configured for this agent'
          : (
            want === 'docker'
              ? 'Docker is not available on this machine'
              : want === 'ssh'
                ? 'the SSH host is unreachable'
                : 'the ' + want + ' backend is unavailable'
          ) + (avail.error ? ' (' + avail.error + ')' : '');

    const id =
      avail.state === 'absent' ||
      fallbackPolicy === 'allow'
        ? defaultBackendId
        : want;

    return {
      id,
      requested: want,
      matched: false,
      reason,
      profileId,
      availability: avail.state
    };
  }

  function backendForProfile(profileId) {
    return resolveBackend(profileId).id;
  }

  function resolutionFor(agentId) {
    const id = String(agentId || 'agent');

    if (
      teoGatewayEnabled &&
      id === 'engineer'
    ) {
      const ready = teoSocketReady();

      return {
        id: 'teo-gateway',
        requested: 'teo-gateway',
        matched: ready,
        reason: ready
          ? null
          : 'TEO gateway socket unavailable',
        profileId: String(
          profileForAgent(id) || 'station-gear'
        ),
        availability: ready ? 'ready' : 'unavailable'
      };
    }

    try {
      if (
        environments.local &&
        forceLocalForAgent(id) === true
      ) {
        return {
          id: 'local',
          requested: 'local',
          matched: true,
          reason: null,
          profileId: String(
            profileForAgent(id) || 'station-gear'
          ),
          forcedLocal: true,
          availability: 'ready'
        };
      }
    } catch (_) {}

    return resolveBackend(profileForAgent(id), id);
  }

  function backendIdFor(agentId) {
    return resolutionFor(agentId).id;
  }

  function sandboxError(res) {
    const label =
      res.profileId === 'safe-cell'
        ? 'SAFE CELL'
        : res.profileId === 'remote-ssh'
          ? 'REMOTE SSH'
          : res.profileId;

    const fix =
      res.requested === 'docker'
        ? "Start Docker, or change the agent's execution profile."
        : res.requested === 'ssh'
          ? "Configure an SSH target, or change the agent's execution profile."
          : "Change the agent's execution profile.";

    const e = new Error(
      "This agent's profile is " +
      label + ' but ' + res.reason + '. ' +
      fix +
      ' The command was NOT run on this computer.'
    );

    e.code = 'sandbox_unavailable';
    e.requested = res.requested;
    e.reason = res.reason;
    e.profileId = res.profileId;

    e.precondition = {
      code: 'sandbox_unavailable',
      requiredState:
        res.requested + '_backend_available',
      requiredAction:
        'start_' +
        res.requested +
        '_or_change_execution_profile'
    };

    return e;
  }

  const EXECUTE_METHODS = [
    'execute',
    'startBackground',
    'spawnStdio',
    'ensureReady',
    'syncWorkspace'
  ];

  const refusingCache = new Map();

  function refusingProxy(real, res) {
    const key =
      'refuse|' + res.requested + '|' + res.profileId;

    if (refusingCache.has(key)) {
      return refusingCache.get(key);
    }

    const proxy = Object.create(real);

    for (const m of EXECUTE_METHODS) {
      proxy[m] = m === 'spawnStdio'
        ? (() => {
          throw sandboxError(res);
        })
        : (() => Promise.reject(sandboxError(res)));
    }

    proxy.sandboxUnavailable = Object.freeze({
      requested: res.requested,
      reason: res.reason,
      profileId: res.profileId
    });

    proxy.describe = agentId =>
      Object.assign({}, real.describe(agentId), {
        sandboxUnavailable: proxy.sandboxUnavailable
      });

    refusingCache.set(key, proxy);

    return proxy;
  }

  function honestProxy(real, backendId, profileId) {
    const key =
      'honest|' + backendId + '|' + profileId;

    if (refusingCache.has(key)) {
      return refusingCache.get(key);
    }

    const proxy = Object.create(real);

    for (const m of EXECUTE_METHODS) {
      proxy[m] = function () {
        const args =
          Array.prototype.slice.call(arguments);

        const agentId =
          args[0] &&
          typeof args[0] === 'object'
            ? args[0].agentId
            : args[0];

        const retype = e => {
          const res =
            resolveBackend(profileId, agentId);

          if (res.matched !== false) {
            return e;
          }

          const typed = sandboxError(res);
          typed.cause = e;

          return typed;
        };

        let out;

        try {
          out = real[m].apply(real, args);
        } catch (e) {
          throw retype(e);
        }

        return out && typeof out.then === 'function'
          ? out.catch(e => {
            throw retype(e);
          })
          : out;
      };
    }

    refusingCache.set(key, proxy);

    return proxy;
  }

  function refusalFor(agentId) {
    const res = resolutionFor(agentId);

    if (
      res.id === 'teo-gateway' &&
      !res.matched
    ) {
      return teoUnavailable('socket');
    }

    if (
      fallbackPolicy !== 'refuse' ||
      res.forcedLocal ||
      res.matched !== false ||
      res.id === res.requested
    ) {
      return null;
    }

    return sandboxError(res);
  }

  function forAgent(agentId) {
    const res = resolutionFor(agentId);

    if (res.id === 'teo-gateway') {
      if (!teoBackend) {
        teoBackend = makeTeoBackend();
      }

      return teoBackend;
    }

    const real =
      environments[res.id] ||
      environments[defaultBackendId];

    if (
      fallbackPolicy !== 'refuse' ||
      res.forcedLocal ||
      res.requested === 'local'
    ) {
      return real;
    }

    if (
      res.matched === false &&
      res.id !== res.requested
    ) {
      return refusingProxy(real, res);
    }

    if (
      res.requested !== 'local' &&
      res.requested !== defaultBackendId
    ) {
      return honestProxy(
        real,
        res.id,
        res.profileId
      );
    }

    return real;
  }

  function fromOpts(opts) {
    return forAgent(opts && opts.agentId);
  }

  function describeAgent(agentId) {
    const res = resolutionFor(agentId);
    const backend = forAgent(agentId);

    const effectiveBackend = String(
      backend.backendId ||
      backend.id ||
      res.id
    );

    return Object.assign(
      {},
      backend.describe(agentId),
      {
        routed: true,
        executionProfile: String(
          profileForAgent(
            String(agentId || 'agent')
          ) || 'station-gear'
        ),
        effectiveBackend,
        requestedBackend: res.requested,
        backendMatched: res.matched !== false,
        mismatchReason:
          res.matched === false ? res.reason : null,
        sandboxFallback: fallbackPolicy,
        refusing:
          res.matched === false &&
          fallbackPolicy === 'refuse'
      }
    );
  }

  function describe() {
    const base = Object.assign(
      {},
      environments[defaultBackendId].describe()
    );

    base.routing = {
      perAgent: true,
      defaultBackend: defaultBackendId,
      availableBackends: Object.keys(environments)
        .filter(id => environments[id]),
      sandboxFallback: fallbackPolicy
    };

    return base;
  }

  function callAgent(method, agentId, rest) {
    const env = forAgent(agentId);

    return env[method].apply(
      env,
      [agentId].concat(rest || [])
    );
  }

  function killAllBackground(agentId) {
    if (agentId != null) {
      return callAgent(
        'killAllBackground',
        agentId,
        []
      );
    }

    let count = 0;
    const seen = new Set();

    for (const [id, env] of Object.entries(environments)) {
      if (
        !env ||
        seen.has(env) ||
        typeof env.killAllBackground !== 'function'
      ) {
        continue;
      }

      seen.add(env);

      const r = env.killAllBackground();

      if (r && typeof r.then === 'function') {
        r.then(
          null,
          swallow('execution.killAll.' + id)
        );
        continue;
      }

      count += Number(r) || 0;
    }

    return count;
  }

  const api = {
    id: 'router',

    supports: environments[defaultBackendId].supports,

    describe,
    describeAgent,
    backendIdFor,
    backendIdForProfile: backendForProfile,
    resolveBackend,
    resolutionFor,
    refusalFor,
    sandboxFallback: fallbackPolicy,
    forAgent,

    ensureReady: agentId =>
      callAgent('ensureReady', agentId, []),

    cleanupAgent: (agentId, opts) =>
      callAgent('cleanupAgent', agentId, [opts]),

    cleanupIdle: (agentIds, opts) =>
      environments.docker &&
      typeof environments.docker.cleanupIdle === 'function'
        ? environments.docker.cleanupIdle(
          agentIds,
          opts
        )
        : Promise.resolve({
          ok: true,
          enabled: false,
          checked: 0,
          stopped: [],
          skipped: []
        }),

    syncWorkspace: (agentId, opts) =>
      callAgent('syncWorkspace', agentId, [opts]),

    invalidateAgent: agentId =>
      callAgent('invalidateAgent', agentId, []),

    workspaceRoot: agentId =>
      callAgent('workspaceRoot', agentId, []),

    ensureWorkspace: agentId =>
      callAgent('ensureWorkspace', agentId, []),

    getCwd: agentId =>
      callAgent('getCwd', agentId, []),

    rememberCwd: (agentId, cwd) =>
      callAgent('rememberCwd', agentId, [cwd]),

    commandEnv: opts => {
      const env = fromOpts(opts);

      return typeof env.commandEnv === 'function'
        ? env.commandEnv(opts)
        : null;
    },

    execute: opts =>
      fromOpts(opts).execute(opts),

    startBackground: opts =>
      fromOpts(opts).startBackground(opts),

    statusBackground: (agentId, bgId) =>
      callAgent(
        'statusBackground',
        agentId,
        [bgId]
      ),

    readBackground: (agentId, bgId, opts) =>
      callAgent(
        'readBackground',
        agentId,
        [bgId, opts]
      ),

    writeBackground: (agentId, bgId, opts) =>
      callAgent(
        'writeBackground',
        agentId,
        [bgId, opts]
      ),

    closeBackgroundStdin: (agentId, bgId) =>
      callAgent(
        'closeBackgroundStdin',
        agentId,
        [bgId]
      ),

    killBackground: (agentId, bgId) =>
      callAgent(
        'killBackground',
        agentId,
        [bgId]
      ),

    waitBackground: (agentId, bgId, opts) => {
      const env = forAgent(agentId);

      return env &&
        typeof env.waitBackground === 'function'
          ? env.waitBackground(
            agentId,
            bgId,
            opts
          )
          : null;
    },

    spawnStdio: opts =>
      fromOpts(opts).spawnStdio(opts),

    killAllBackground,

    _environments: environments
  };

  Object.defineProperty(api, 'backendId', {
    enumerable: true,
    get: () => defaultBackendId
  });

  return api;
}

module.exports = { makeExecutionRouter };
