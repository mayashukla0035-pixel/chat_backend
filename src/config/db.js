const mongoose = require('mongoose');

async function connectDB(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    // Pool sized for thousands of concurrent users on one process: enough
    // parallel sockets for the hot endpoints without exhausting Atlas/Atlas
    // connection limits, with sane timeouts so a slow query releases the
    // socket instead of pinning it.
    maxPoolSize: Number(process.env.MONGO_MAX_POOL || 100),
    minPoolSize: 5,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 10000,
    retryWrites: true,
  });
  console.log('[mongo] connected');
}

module.exports = { connectDB };
