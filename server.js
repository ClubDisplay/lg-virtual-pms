const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use('/autocheckout', (req, res, next) => {
  const { debug, hour, min } = req.query;
  console.log(`debug: ${debug}, hour: ${hour}, min: ${min}`);
  next();
}, express.static(path.join(__dirname, 'app')));

app.get('/', (req, res) => {
  res.send('Virtual PMS - Access: /autocheckout?debug=on&hour=11&min=00');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
