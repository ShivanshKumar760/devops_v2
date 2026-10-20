import mongoose from 'mongoose';

export function connectDB(uri) {
  // Listeners stay the same to monitor ongoing lifecycle events
  mongoose.connection.on('connected', () => console.log('[db] connected to MongoDB'));
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected'));
  mongoose.connection.on('error', (err) => console.error('[db] error', err.message));

  // Explicitly return a new Promise object
  return new Promise((resolve, reject) => {
    mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10_000, 
      maxPoolSize: 10,                 
    })
    .then(() => {
      resolve(); // Resolves the promise when connection is successful
    })
    .catch((err) => {
      reject(err); // Rejects the promise if connection fails (e.g. IP allowlist error)
    });
  });
}

export function disconnectDB() {
  return mongoose.disconnect(); // Already returns a Promise natively
}
