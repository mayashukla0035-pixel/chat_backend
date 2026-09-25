// Short-TTL in-memory cache of the full Group collection.
//
// Groups only change through the periodic sheet sync (every few minutes) or a
// group-avatar upload (invalidated explicitly below), yet they were loaded
// from Mongo on EVERY socket join, every message send, every conversation
// list and several search endpoints. A 30s TTL serves them from memory while
// still picking up sync edits almost immediately.
const Group = require('../models/Group');

const TTL_MS = Number(process.env.GROUP_CACHE_TTL_MS || 30000);
let list = null;
let map = null;
let at = 0;

async function cachedGroups() {
  if (list && Date.now() - at < TTL_MS) return { list, map };
  const fresh = await Group.find({}).lean();
  list = fresh;
  map = new Map(fresh.map((g) => [g.groupId, g]));
  at = Date.now();
  return { list, map };
}

// Call after any write to a Group document so the next read is fresh.
function invalidateGroups() {
  list = null;
  map = null;
  at = 0;
}

module.exports = { cachedGroups, invalidateGroups };
