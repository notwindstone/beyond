const path = require("node:path");
exports.joined = path.join("a", "b");
exports.data = require("./data.json");
module.exports.self = typeof module.exports;
