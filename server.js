const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  const { debug, hour, min } = req.query;
  if (req.path === '/index.html' || req.path === '/') {
    console.log(`debug: ${debug}, hour: ${hour}, min: ${min}`);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'app')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
