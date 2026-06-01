function errorHandler(err, req, res, next) {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} —`, err.message);

  if (err.response) {
    // Error de API externa (Bizneo, OpenRouter, Sheets)
    return res.status(502).json({
      success: false,
      error: 'External API error',
      detail: err.response.data || err.message,
    });
  }

  res.status(500).json({ success: false, error: err.message });
}

module.exports = errorHandler;
