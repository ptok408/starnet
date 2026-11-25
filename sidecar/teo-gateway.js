'use strict';

// Klient istniejacej bramy TEO na Contabo.
// Sam ten modul nie stanowi zabezpieczenia przed innymi agentami.

const net = require('node:net');
const SOCKET = '/run/starnet-gateway.sock';

function execute(command, agentId) {
  if (agentId !== 'engineer') {
    return Promise.reject(new Error('Agent not authorized'));
  }

  if (
    typeof command !== 'string' ||
    !command.trim() ||
    command.length > 4096
  ) {
    return Promise.reject(new Error('Invalid command'));
  }

  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCKET);
    let output = '';
    let bytes = 0;
    let finished = false;

    function fail(error) {
      if (finished) return;
      finished = true;
      conn.destroy();
      reject(error);
    }

    conn.setTimeout(190000);

    conn.on('connect', () => {
      conn.write(JSON.stringify({ command }));
    });

    conn.on('data', chunk => {
      bytes += chunk.length;

      if (bytes > 150000) {
        return fail(new Error('Gateway response too large'));
      }

      output += chunk.toString('utf8');
    });

    conn.on('end', () => {
      if (finished) return;

      try {
        const result = JSON.parse(output);

        if (
          !result ||
          result.error ||
          !Number.isInteger(result.exit_code) ||
          typeof result.stdout !== 'string' ||
          typeof result.stderr !== 'string'
        ) {
          throw new Error(result?.error || 'Invalid response');
        }

        finished = true;
        resolve(result);
      } catch (error) {
        fail(error);
      }
    });

    conn.on('error', fail);

    conn.on('timeout', () => {
      fail(new Error('Gateway timeout'));
    });

    conn.on('close', () => {
      if (!finished) {
        fail(new Error('Gateway connection closed'));
      }
    });
  });
}

module.exports = { execute };
