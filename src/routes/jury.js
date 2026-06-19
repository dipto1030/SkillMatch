const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const juryService = require('../services/juryService');

// GET /api/jury/eligibility — Check my jury eligibility
router.get('/eligibility', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const result = await juryService.checkEligibility(req.user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/jury/badge/purchase — Buy jury badge
router.post('/badge/purchase', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const result = await juryService.purchaseBadge(req.user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/jury/cases — My assigned jury cases
router.get('/cases', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const cases = await juryService.getMyCases(req.user.id);
    res.json({ success: true, data: cases });
  } catch (err) {
    next(err);
  }
});

// GET /api/jury/cases/:id — Case detail (anonymised)
router.get('/cases/:id', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const juryCase = await juryService.getCase(parseInt(req.params.id));
    if (!juryCase) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Case not found.' } });
    res.json({ success: true, data: juryCase });
  } catch (err) {
    next(err);
  }
});

// POST /api/jury/cases/:id/vote — Submit vote
router.post('/cases/:id/vote', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { vote, explanation } = req.body;
    const result = await juryService.submitVote(req.user.id, parseInt(req.params.id), vote, explanation);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/jury/cases/:id/skip — Skip case
router.post('/cases/:id/skip', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const result = await juryService.skipCase(req.user.id, parseInt(req.params.id));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/jury/badge/reactivate — Reactivate suspended badge
router.post('/badge/reactivate', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const result = await juryService.reactivateBadge(req.user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
