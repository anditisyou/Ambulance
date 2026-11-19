'use strict';

const express = require('express');
const router = express.Router();
const hospitalController = require('../controllers/hospitalController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES } = require('../utils/constants');

router.use(protect);

/**
 * @swagger
 * /api/hospitals/available:
 *   get:
 *     summary: Get nearby hospitals with available beds
 *     tags:
 *       - Hospitals
 *     parameters:
 *       - in: query
 *         name: longitude
 *         schema:
 *           type: number
 *         required: true
 *       - in: query
 *         name: latitude
 *         schema:
 *           type: number
 *         required: true
 *       - in: query
 *         name: maxDistance
 *         schema:
 *           type: number
 *         required: false
 *         description: Maximum distance in meters
 *       - in: query
 *         name: specialty
 *         schema:
 *           type: string
 *         required: false
 *         description: Filter hospitals by specialty
 *     responses:
 *       200:
 *         description: Available hospitals
 */
router.get('/available', hospitalController.getNearbyHospitals);

/**
 * @swagger
 * /api/hospitals/nearest-for-driver:
 *   get:
 *     summary: Get the nearest available hospital for the authenticated driver
 *     tags:
 *       - Hospitals
 *     responses:
 *       200:
 *         description: Nearest hospital with available beds or null
 */
router.get('/nearest-for-driver', authorize(ROLES.DRIVER), hospitalController.getNearestAvailableForDriver);

/**
 * @swagger
 * /api/hospitals/me:
 *   get:
 *     summary: Get the authenticated hospital profile
 *     tags:
 *       - Hospitals
 *     responses:
 *       200:
 *         description: Hospital profile with bed capacity
 */
router.get('/me', authorize(ROLES.HOSPITAL), hospitalController.getHospitalProfile);

/**
 * @swagger
 * /api/hospitals/beds:
 *   put:
 *     summary: Update hospital bed availability
 *     tags:
 *       - Hospitals
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               beds:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                     total:
 *                       type: number
 *                     available:
 *                       type: number
 *     responses:
 *       200:
 *         description: Updated hospital capacity
 */
router.put('/beds', authorize(ROLES.HOSPITAL), hospitalController.updateBeds);

/**
 * @swagger
 * /api/hospitals/beds:
 *   post:
 *     summary: Add a bed category to the authenticated hospital profile
 *     tags:
 *       - Hospitals
 *     responses:
 *       201:
 *         description: Hospital capacity after adding beds
 */
router.post('/beds', authorize(ROLES.HOSPITAL), hospitalController.addBeds);

/**
 * @swagger
 * /api/hospitals/beds/{type}:
 *   patch:
 *     summary: Update one hospital bed category
 *     tags:
 *       - Hospitals
 *     responses:
 *       200:
 *         description: Hospital capacity after updating the selected bed category
 */
router.patch('/beds/:type', authorize(ROLES.HOSPITAL), hospitalController.updateBedType);
router.delete('/beds/:type', authorize(ROLES.HOSPITAL), hospitalController.deleteBedType);

/**
 * @swagger
 * /api/hospitals/availability:
 *   patch:
 *     summary: Toggle hospital availability status
 *     tags:
 *       - Hospitals
 *     responses:
 *       200:
 *         description: Hospital availability toggled
 */
router.patch('/availability', authorize(ROLES.HOSPITAL), hospitalController.toggleAvailability);

/**
 * @swagger
 * /api/hospitals/export:
 *   get:
 *     summary: Export hospital data
 *     tags:
 *       - Hospitals
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [json, csv]
 *         required: false
 *         description: Export format
 *     responses:
 *       200:
 *         description: Hospital data exported
 */
router.get('/export', authorize(ROLES.HOSPITAL), hospitalController.exportData);

/**
 * @swagger
 * /api/hospitals/statistics:
 *   get:
 *     summary: Get hospital statistics
 *     tags:
 *       - Hospitals
 *     responses:
 *       200:
 *         description: Hospital statistics
 */
router.get('/statistics', authorize(ROLES.HOSPITAL), hospitalController.getStatistics);

/**
 * @swagger
 * /api/hospitals:
 *   post:
 *     summary: Register or update hospital profile
 *     tags:
 *       - Hospitals
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               address:
 *                 type: object
 *               location:
 *                 type: object
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               beds:
 *                 type: array
 *               specialties:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Hospital profile saved
 */
router.post('/', authorize(ROLES.HOSPITAL), hospitalController.registerHospital);

module.exports = router;
