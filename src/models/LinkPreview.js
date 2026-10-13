const mongoose = require('mongoose');

/**
 * Cache of unfurled links.
 *
 * A preview is fetched once and then shared by every member of the chat, so
 * scrolling back through a long conversation does not re-scrape the same page
 * on every render — and a link that has since been taken down keeps working
 * for the people who already received the message.
 *
 * TTL is 7 days: long enough to cover any active conversation, short enough
 * that a product page which changed its price does not stay stale forever.
 * `expires` carries its own 0-second TTL index, so Mongo reaps the documents
 * itself and the collection cannot grow without bound.
 */
const LinkPreviewSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true, index: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: null },
  expires: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
});

LinkPreviewSchema.index({ expires: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.LinkPreview || mongoose.model('LinkPreview', LinkPreviewSchema);