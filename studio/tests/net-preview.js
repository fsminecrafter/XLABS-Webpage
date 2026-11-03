// Exercises the preview's SDK DNS and TCP-to-HTTP bridge against a local server.
const fs = require('fs');
const path = require('path');
const http = require('http');
const dir = path.join(__dirname, '..') + '/';
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.url !== '/preview-test' || req.method !== 'POST' || body !== 'ping') {
      res.writeHead(400); res.end('bad request'); return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('network-ok');
  });
});

server.listen(0, () => {
  const port = server.address().port;
  const source = `#include "net.h"
#include "stdio.h"

int main(void) {
    uint32_t ip = 0;
    if (mos_net_resolve("localhost", &ip, 1000) != (long)SYS_SUCCESS) return 1;
    long h = mos_tcp_connect(ip, ${port}, 1000);
    if (h < 0) return 2;
    const char request[] = "POST /preview-test HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Type: text/plain\\r\\nContent-Length: 4\\r\\nConnection: close\\r\\n\\r\\n";
    if (mos_tcp_send(h, request, sizeof(request) - 1) < 0) return 3;
    if (mos_tcp_send(h, "ping", 4) != 4) return 4;
    char response[4096];
    for (int i = 0; i < 200; i++) {
        long n = mos_tcp_recv(h, response, sizeof(response) - 1);
        if (n > 0) { response[n] = 0; mos_puts(response); mos_tcp_close(h); return 0; }
        if (n < 0) break;
        mos_sleep(5);
    }
    mos_tcp_close(h);
    return 5;
}`;

  globalThis.self = globalThis;
  globalThis.onmessage = null;
  globalThis.importScripts = (...files) => files.forEach(file =>
    (0, eval)(fs.readFileSync(dir + file, 'utf8') + '\n//# sourceURL=' + file));
  let output = '';
  let completed = false;
  globalThis.postMessage = (message) => {
    if (message.t === 'out') output += message.text;
    else if (message.t === 'netError') output += 'network error: ' + message.message;
    else if (message.t === 'exit') {
      completed = true;
      clearTimeout(watchdog);
      server.close();
      if (message.code !== 0 || !output.includes('network-ok')) {
        console.error(output || 'No preview output.');
        console.error('Preview exited with code ' + message.code + (message.crash ? ': ' + message.crash : ''));
        process.exitCode = 1;
      } else {
        console.log('ok   preview HTTP networking');
      }
    }
  };
  (0, eval)(fs.readFileSync(dir + 'worker.js', 'utf8') + '\n//# sourceURL=worker.js');
  const watchdog = setTimeout(() => {
    if (!completed) {
      server.close();
      console.error('Preview networking test timed out.\n' + output);
      process.exitCode = 1;
      process.exit();
    }
  }, 15000);
  globalThis.onmessage({ data: {
    t: 'run', files: { 'main.c': source }, name: 'net-preview', args: [],
    resources: [], system: [], screen: { w: 640, h: 480 }
  } });
});
