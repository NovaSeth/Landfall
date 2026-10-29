import http from 'node:http';
import fs from 'node:fs';
import { openStore } from './store.mjs';
import { createApp } from './app.mjs';

fs.mkdirSync('data', { recursive: true });
const port = Number(process.env.PORT) || 3000;
http.createServer(createApp(openStore('data/notes.json'))).listen(port, () => {
  console.log(`notes-api listening on ${port}`);
});
