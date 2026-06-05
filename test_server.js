const express = require('express');
const path = require('path');
const app = express();
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.listen(3999, () => console.log('Test server on 3999'));
