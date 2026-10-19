// Enabling a feature is not evidence that the driver actually decodes in hardware.
exports.mergeDecoderFeatures = (existing = '') => [...new Set([
  ...existing.split(',').filter(Boolean), 'VaapiVideoDecoder', 'VaapiIgnoreDriverChecks',
])].join(',');
