const mongoose = require('mongoose');

async function connectDB(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log('[mongo] connected');
}

module.exports = { connectDB };
