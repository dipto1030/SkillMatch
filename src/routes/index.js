const express = require('express');
const router = express.Router();

router.use('/', require('./auth'));
router.use('/wallet', require('./wallet'));
router.use('/games', require('./games'));
router.use('/matches', require('./matches'));
router.use('/disputes', require('./disputes'));
router.use('/jury', require('./jury'));
router.use('/profile', require('./profile'));
router.use('/leaderboard', require('./leaderboard'));
router.use('/report', require('./reports'));
router.use('/admin', require('./admin'));

module.exports = router;
