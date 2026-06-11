const http = require('http');
const body = JSON.stringify({
  model: 'llama3.1:8b-instruct-q4_0',
  messages: [{role: 'user', content: 'search for trump'}],
  stream: false,
  tools: [{
    type: 'function',
    function: {
      name: 'find_history',
      description: 'Search your browsing history',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '' } },
        required: ['query']
      }
    }
  }],
  options: { num_predict: 2048, temperature: 0.3 }
});
const req = http.request({
  hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'BODY:', data));
});
req.on('error', e => console.error(e));
req.write(body);
req.end();
