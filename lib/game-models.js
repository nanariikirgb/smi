const index = require('./game-model-index.json');
const keys = new Set(Object.entries(index).flatMap(([material, numbers]) =>
  numbers.map(number => material + ':' + number)));
exports.hasModel = key => keys.has(key);
