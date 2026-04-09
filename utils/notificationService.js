// utils/notificationService.js
'use strict';

/**
 * Notification Service — handles SMS, email, Slack, and webhook alerts
 * Supports Twilio for SMS, Nodemailer for email, Slack API, and HTTP webhooks
 */

const nodemailer = require('nodemailer');
const twilio = require('twilio');
const axios = require('axios');

class NotificationService {
  constructor() {
    this.emailTransporter = null;
    this.twilioClient = null;
    this.slackWebhookUrl = null;
    this.webhookUrls = [];
    this.init();
  }

  init() {
    // Initialize email transporter if credentials exist
    if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      this.emailTransporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: process.env.EMAIL_SECURE === 'true',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });
      console.info('[Notification] Email service initialized');
    } else {
      console.warn('[Notification] Email credentials missing — email notifications disabled');
    }

    // Initialize Twilio if credentials exist
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
      this.twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      console.info('[Notification] SMS service initialized');
    } else {
      console.warn('[Notification] Twilio credentials missing — SMS notifications disabled');
    }

    // Initialize Slack webhook
    if (process.env.SLACK_WEBHOOK_URL) {
      this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
      console.info('[Notification] Slack webhook initialized');
    } else {
      console.warn('[Notification] Slack webhook URL missing — Slack notifications disabled');
    }

    // Initialize webhook URLs
    if (process.env.ALERT_WEBHOOK_URLS) {
      this.webhookUrls = process.env.ALERT_WEBHOOK_URLS.split(',').map(url => url.trim());
      console.info(`[Notification] ${this.webhookUrls.length} webhook URLs configured`);
    } else {
      console.warn('[Notification] Alert webhook URLs missing — webhook notifications disabled');
    }
  }

  /**
   * Send SMS notification
   * @param {string} to - Phone number (E.164 format)
   * @param {string} message - Message content
   * @returns {Promise<boolean>}
   */
  async sendSMS(to, message) {
    if (!this.twilioClient) {
      console.warn('[Notification] SMS not sent — service unavailable');
      return false;
    }

    try {
      const result = await this.twilioClient.messages.create({
        body: message,
        to: to,
        from: process.env.TWILIO_PHONE_NUMBER,
      });
      console.info(`[Notification] SMS sent to ${to}: ${result.sid}`);
      return true;
    } catch (error) {
      console.error('[Notification] SMS error:', error.message);
      return false;
    }
  }

  /**
   * Send Slack notification
   * @param {string} message - Message content
   * @param {string} channel - Slack channel (optional, uses webhook default)
   * @returns {Promise<boolean>}
   */
  async sendSlack(message, channel = null) {
    if (!this.slackWebhookUrl) {
      console.warn('[Notification] Slack not sent — service unavailable');
      return false;
    }

    try {
      const payload = {
        text: message,
        ...(channel && { channel }),
      };

      const response = await axios.post(this.slackWebhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      });

      if (response.status === 200) {
        console.info('[Notification] Slack message sent');
        return true;
      } else {
        console.error('[Notification] Slack error:', response.status, response.data);
        return false;
      }
    } catch (error) {
      console.error('[Notification] Slack error:', error.message);
      return false;
    }
  }

  /**
   * Send webhook notification
   * @param {Object} payload - Webhook payload
   * @returns {Promise<boolean>}
   */
  async sendWebhook(payload) {
    if (this.webhookUrls.length === 0) {
      console.warn('[Notification] Webhook not sent — no URLs configured');
      return false;
    }

    const results = await Promise.allSettled(
      this.webhookUrls.map(async (url) => {
        try {
          const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000,
          });
          return response.status === 200;
        } catch (error) {
          console.error(`[Notification] Webhook error for ${url}:`, error.message);
          return false;
        }
      })
    );

    const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
    console.info(`[Notification] Webhook sent to ${successCount}/${this.webhookUrls.length} URLs`);
    return successCount > 0;
  }

  /**
   * Send alert notification to all configured channels
   * @param {Object} alert - Alert object with type, severity, message, value
   * @returns {Promise<void>}
   */
  async sendAlert(alert) {
    const { type, severity, message, value } = alert;
    const timestamp = new Date().toISOString();

    const alertMessage = `[${severity.toUpperCase()}] ${type}: ${message}`;
    const slackMessage = `🚨 *ERS Alert*\n• **Type:** ${type}\n• **Severity:** ${severity}\n• **Message:** ${message}\n• **Value:** ${value}\n• **Time:** ${timestamp}`;

    const webhookPayload = {
      alert_type: type,
      severity,
      message,
      value,
      timestamp,
      service: 'emergency-response-system',
    };

    // Send to all channels concurrently
    await Promise.allSettled([
      this.sendSlack(slackMessage),
      this.sendWebhook(webhookPayload),
      // Could also send email/SMS for critical alerts
      ...(severity === 'error' ? [
        this.sendEmail(
          process.env.ALERT_EMAIL_RECIPIENTS || 'admin@emergency-response.com',
          `🚨 ERS Critical Alert: ${type}`,
          `<h2>Critical Alert</h2><p><strong>${message}</strong></p><p>Value: ${value}</p><p>Time: ${timestamp}</p>`
        )
      ] : [])
    ]);
  }

  /**
   * Notify citizen about ambulance assignment
   */
  async notifyCitizenAssigned(user, ambulance, etaMinutes) {
    const smsMsg = `🚑 ERS: Ambulance assigned! Vehicle: ${ambulance.plateNumber}. ETA: ${etaMinutes} min. Track at: ${process.env.FRONTEND_URL}/track`;
    const emailHtml = `
      <h2>Emergency Response Assigned</h2>
      <p>Dear ${user.name},</p>
      <p>An ambulance has been assigned to your emergency request.</p>
      <ul>
        <li><strong>Vehicle:</strong> ${ambulance.plateNumber}</li>
        <li><strong>Estimated Arrival:</strong> ${etaMinutes} minutes</li>
        <li><strong>Track Live:</strong> <a href="${process.env.FRONTEND_URL}/track">Click here</a></li>
      </ul>
      <p>Stay safe. Help is on the way.</p>
    `;

    await Promise.all([
      this.sendSMS(user.phone, smsMsg),
      this.sendEmail(user.email, '🚑 Ambulance Assigned - ERS', emailHtml),
    ]);
  }

  /**
   * Notify driver about new assignment
   */
  async notifyDriverAssigned(driver, request, etaMinutes) {
    const smsMsg = `🚑 ERS: New assignment! Patient: ${request.userName}. Location: ${request.location.coordinates[1]}, ${request.location.coordinates[0]}. ETA: ${etaMinutes} min.`;
    const emailHtml = `
      <h2>New Dispatch Assignment</h2>
      <p>Driver ${driver.name},</p>
      <p>You have been assigned to an emergency request.</p>
      <ul>
        <li><strong>Patient:</strong> ${request.userName}</li>
        <li><strong>Phone:</strong> ${request.userPhone}</li>
        <li><strong>ETA:</strong> ${etaMinutes} minutes</li>
        <li><strong>Dashboard:</strong> <a href="${process.env.FRONTEND_URL}/ambulance-dashboard">View Assignment</a></li>
      </ul>
      <p>Please respond immediately.</p>
    `;

    await Promise.all([
      this.sendSMS(driver.phone, smsMsg),
      this.sendEmail(driver.email, '🚑 New Dispatch Assignment - ERS', emailHtml),
    ]);
  }

  /**
   * Notify hospital about pending request
   */
  async notifyHospitalPending(hospital, request) {
    const emailHtml = `
      <h2>New Emergency Request Pending</h2>
      <p>Hospital ${hospital.name},</p>
      <p>A new emergency request requires attention.</p>
      <ul>
        <li><strong>Patient:</strong> ${request.userName}</li>
        <li><strong>Phone:</strong> ${request.userPhone}</li>
        <li><strong>Priority:</strong> ${request.priority}</li>
        <li><strong>Location:</strong> ${request.location.coordinates[1]}, ${request.location.coordinates[0]}</li>
        <li><strong>Dashboard:</strong> <a href="${process.env.FRONTEND_URL}/hospital-dashboard">View Request</a></li>
      </ul>
      <p>Please respond promptly.</p>
    `;

    await this.sendEmail(hospital.email, '🚨 New Emergency Request - ERS', emailHtml);
  }
}

module.exports = new NotificationService();