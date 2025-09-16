const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('🚀 Saka 360 Backend is running locally!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
