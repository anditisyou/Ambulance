'use strict';
const express      = require('express');
const router       = express.Router();
const ctrl         = require('../controllers/dispatchController');
const { protect }  = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES }    = require('../utils/constants');

/**
 * @swagger
 * tags:
 *   - name: Dispatch
 *     description: Emergency dispatch and ambulance assignment endpoints
 */

router.use(protect);

/**
 * @swagger
 * /api/dispatch/request:
 *   post:
 *     summary: Create a new emergency dispatch request
 *     tags:
 *       - Dispatch
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               priority:
 *                 type: string
 *                 enum: [LOW, MEDIUM, HIGH, CRITICAL]
 *               type:
 *                 type: string
 *                 enum: [MEDICAL, TRAUMA, CARDIAC, RESPIRATORY]
 *               description:
 *                 type: string
 *               allergies:
 *                 type: string
 *               triageNotes:
 *                 type: string
 *               medicalHistorySummary:
 *                 type: string
 *               vitals:
 *                 type: object
 *                 properties:
 *                   heartRate:
 *                     type: number
 *                   bloodPressure:
 *                     type: string
 *                   respiratoryRate:
 *                     type: number
 *                   temperature:
 *                     type: number
 *                   oxygenSaturation:
 *                     type: number
 *     responses:
 *       201:
 *         description: Emergency request created
 */
router.post('/request', authorize(ROLES.CITIZEN), ctrl.newRequest);

/**
 * @swagger
 * /api/dispatch/active:
 *   get:
 *     summary: Get the authenticated user's active emergency request
 *     tags:
 *       - Dispatch
 *     responses:
 *       200:
 *         description: Active emergency request or null
 */
router.get('/active', authorize(ROLES.CITIZEN), ctrl.getActive);

/**
 * @swagger
 * /api/dispatch/assignments:
 *   get:
 *     summary: Get assignments for the authenticated ambulance driver
 *     tags:
 *       - Dispatch
 *     responses:
 *       200:
 *         description: Driver assignments list
 */
router.get('/assignments', authorize(ROLES.DRIVER), ctrl.getAssignments);

/**
 * @swagger
 * /api/dispatch/{id}/response:
 *   put:
 *     summary: Driver accepts or rejects a dispatch assignment
 *     tags:
 *       - Dispatch
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               accept:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Assignment response recorded
 */
router.put('/:id/response', authorize(ROLES.DRIVER), ctrl.driverResponse);

/**
 * @swagger
 * /api/dispatch/{id}/track:
 *   patch:
 *     summary: Update ambulance position or request status while en route
 *     tags:
 *       - Dispatch
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               longitude:
 *                 type: number
 *               latitude:
 *                 type: number
 *               status:
 *                 type: string
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tracking update applied
 */
router.patch('/:id/track', authorize(ROLES.DRIVER), ctrl.track);

/**
 * @swagger
 * /api/dispatch/{id}:
 *   delete:
 *     summary: Cancel a pending or assigned emergency request
 *     tags:
 *       - Dispatch
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: Request cancelled successfully
 */
router.delete('/:id', authorize(ROLES.CITIZEN), ctrl.cancelRequest);

module.exports = router;
