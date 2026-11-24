'use strict';

// Vercel serverless entry. server.js exports the Express app when required
// (it only listens when run as `node server.js`), so this just wires it up.
const path = require('node:path');

// Tell the app where the project root is, so res.sendFile() finds
// index.html, app.js, styles.css, logo.png and the vendor files.
process.env.APP_ROOT = path.resolve(__dirname, '..');

module.exports = require('../server.js');