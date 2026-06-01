const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cvParserService = require('../services/cvParserService');
const scoringService = require('../services/scoringService');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `cv_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// POST /api/cv/upload — subir y parsear un CV manualmente
router.post('/upload', upload.single('cv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded or invalid format (PDF/DOC only)' });
  }

  try {
    const ext    = path.extname(req.file.originalname).toLowerCase();
    const isWord = ext === '.doc' || ext === '.docx';
    const cvText = isWord
      ? await cvParserService.extractTextFromDocx(req.file.path)
      : await cvParserService.extractTextFromPDF(req.file.path);

    const parsedCV = await cvParserService.parseCVWithLLM(cvText);
    const score    = scoringService.calculateScore({}, parsedCV);
    const label    = { label: score.classification.label, color: score.classification.bg };

    fs.unlink(req.file.path, () => {});
    res.json({ success: true, parsedCV, score, label });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
