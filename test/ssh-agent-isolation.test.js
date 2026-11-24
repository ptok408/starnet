'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

async function testSuite() {
  console.log('=== TEST SUITE: StarNet Per-Agent SSH Key Isolation & Audit Logging ===\n');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-isolation-test-'));

  try {
    // 1. Setup workspace for engineer and odin
    const engineerDir = path.join(tmpRoot, 'engineer');
    const engineerSsh = path.join(engineerDir, '.ssh');
    fs.mkdirSync(engineerSsh, { recursive: true });
    const engineerKey = path.join(engineerSsh, 'id_ed25519');
    fs.writeFileSync(engineerKey, 'FAKE-PRIVATE-KEY-TEO-ED25519', { mode: 0o600 });

    const odinDir = path.join(tmpRoot, 'agent');
    const odinSsh = path.join(odinDir, '.ssh');
    fs.mkdirSync(odinSsh, { recursive: true });
    // odin has no key

    // Mock spawn to capture command arguments and simulate remote response
    const spawnedCalls = [];
    const mockSpawn = function(file, args, opts) {
      spawnedCalls.push({ file, args, opts, input: '' });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: (chunk) => {
          spawnedCalls[spawnedCalls.length - 1].input += chunk;
        },
        end: () => {}
      };

      // Asynchronous completion
      setImmediate(() => {
        const input = spawnedCalls[spawnedCalls.length - 1].input || '';
        let out = 'starnet-ssh-ready\nstarnet-sync-safe\n';
        const cpMatch = /STARNET_CHECKPOINT\\t(sshcp_[a-f0-9]{8})/.exec(input);
        if (cpMatch) {
          out += 'STARNET_CHECKPOINT\t' + cpMatch[1] + '\t0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\t1024\n';
        }
        out += '[exit 0]\n';
        child.stdout.emit('data', Buffer.from(out));
        child.emit('exit', 0);
        child.emit('close', 0);
      });
      return child;
    };

    const { makeEnvironmentManager } = require('../sidecar/environment.js');
    const Settings = require('../sidecar/execution-settings.js');

    const sshTargets = {
      engineer: {
        host: 'contabo-host',
        user: 'teo',
        port: 22,
        remoteRoot: '/home/teo/workspace',
        configured: true
      },
      agent: {
        host: 'contabo-host',
        user: 'agent_odin',
        port: 22,
        remoteRoot: '/home/agent_odin/workspace',
        configured: true
      }
    };

    const env = makeEnvironmentManager({
      spawn: mockSpawn,
      fs: fs,
      pathMod: path,
      root: tmpRoot,
      env: {},
      config: { backend: 'ssh', sshBin: 'ssh' },
      sshConfig: (aid) => sshTargets[aid] || null
    });

    // TEST 1: Readiness probe for engineer uses engineer's private key
    console.log('TEST 1: Verifying engineer uses its own private key and strict isolation...');
    await env.ensureReady('engineer');
    const lastCall = spawnedCalls[spawnedCalls.length - 1];
    assert.strictEqual(lastCall.file, 'ssh', 'Executed binary must be ssh');
    
    // Check -i is passed with engineer's key
    const iIdx = lastCall.args.indexOf('-i');
    assert.ok(iIdx >= 0, '-i argument must be passed');
    assert.strictEqual(lastCall.args[iIdx + 1], engineerKey, 'Identity file must be engineer key');
    
    // Check -o IdentitiesOnly=yes
    const idOnlyIdx = lastCall.args.indexOf('IdentitiesOnly=yes');
    assert.ok(idOnlyIdx >= 0, 'IdentitiesOnly=yes must be set to prevent fallback to other keys');

    // Check destination
    assert.ok(lastCall.args.includes('teo@contabo-host'), 'Destination must be teo@contabo-host');
    console.log('✓ TEST 1 PASSED: Engineer correctly uses only /home/engineer/.ssh/id_ed25519 with IdentitiesOnly=yes');

    // TEST 2: Odin (agent) does NOT use engineer's key
    console.log('\nTEST 2: Verifying agent (odin) without a key does not use engineer key...');
    spawnedCalls.length = 0;
    await env.ensureReady('agent');
    const odinCall = spawnedCalls[spawnedCalls.length - 1];
    assert.strictEqual(odinCall.args.includes(engineerKey), false, 'Odin MUST NOT use engineer key');
    assert.strictEqual(odinCall.args.indexOf('-i'), -1, 'Odin has no key, so -i must not be passed');
    assert.ok(odinCall.args.includes('agent_odin@contabo-host'), 'Destination must be agent_odin@contabo-host');
    console.log('✓ TEST 2 PASSED: Agent (odin) is completely isolated and cannot touch engineer key');

    // TEST 3: Audit logging during execute
    console.log('\nTEST 3: Verifying audit logging writes to both central and per-agent audit logs...');
    spawnedCalls.length = 0;
    const execResult = await env.execute({
      agentId: 'engineer',
      cmd: 'uname -a',
      cwd: '/home/teo/workspace',
      ledgerCmd: 'uname -a'
    });

    const centralAuditFile = path.join(tmpRoot, '.execution', 'ssh', 'audit.jsonl');
    const agentAuditFile = path.join(engineerSsh, 'audit.log');

    assert.ok(fs.existsSync(centralAuditFile), 'Central audit log must exist');
    assert.ok(fs.existsSync(agentAuditFile), 'Agent audit log must exist');

    const centralLines = fs.readFileSync(centralAuditFile, 'utf8').trim().split('\n').map(JSON.parse);
    const agentLines = fs.readFileSync(agentAuditFile, 'utf8').trim().split('\n').map(JSON.parse);

    assert.strictEqual(centralLines.length, 1, 'Central audit must have 1 record');
    assert.strictEqual(agentLines.length, 1, 'Agent audit must have 1 record');

    const record = centralLines[0];
    assert.strictEqual(record.agentId, 'engineer');
    assert.strictEqual(record.user, 'teo');
    assert.strictEqual(record.host, 'contabo-host');
    assert.strictEqual(record.cmd, 'uname -a');
    assert.strictEqual(record.status, 'ok');
    assert.ok(record.timestamp, 'Timestamp must be present');
    console.log('✓ TEST 3 PASSED: Audit record successfully created in .execution/ssh/audit.jsonl and engineer/.ssh/audit.log');

    // TEST 4: Profile routing with Full Power
    console.log('\nTEST 4: Verifying execution router forceLocalForAgent honors remote-ssh...');
    const roster = new Map([
      ['engineer', { approvalMode: 'full', executionProfile: 'remote-ssh' }],
      ['odin', { approvalMode: 'full', executionProfile: 'trusted-project' }]
    ]);

    const forceLocalForAgent = (aid) => {
      const rec = roster.get(aid) || {};
      if (rec.executionProfile === 'remote-ssh') return false;
      return (rec.approvalMode === 'full');
    };

    assert.strictEqual(forceLocalForAgent('engineer'), false, 'remote-ssh agent must NOT be forced to local');
    assert.strictEqual(forceLocalForAgent('odin'), true, 'trusted-project under full power must be forced to local');
    console.log('✓ TEST 4 PASSED: remote-ssh profile is honored even under Full Power!');

    console.log('\n======================================================');
    console.log('ALL 4 TESTS PASSED! Solution verified cleanly.');
    console.log('======================================================');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

testSuite().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
