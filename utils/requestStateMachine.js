'use strict';

/**
 * Request State Machine
 * Strict state transitions with validation
 * PENDING → ASSIGNED → ACCEPTED → EN_ROUTE → COMPLETED
 * ASSIGNED → REJECTED (driver rejects)
 */

const { REQUEST_STATUS, AMBULANCE_STATUS } = require('./constants');

const VALID_TRANSITIONS = {
  PENDING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['EN_ROUTE', 'CANCELLED'],
  EN_ROUTE: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: ['ASSIGNED'], // Can be reassigned
  CANCELLED: [], // Terminal state
};

class RequestStateMachine {
  constructor(request) {
    this.request = request;
    this.currentState = request.status;
    this.transitionHistory = [];
  }

  isValidTransition(newState) {
    const validStates = VALID_TRANSITIONS[this.currentState] || [];
    return validStates.includes(newState);
  }

  async transitionTo(newState, metadata = {}) {
    if (!this.isValidTransition(newState)) {
      throw new Error(
        `Invalid transition from ${this.currentState} to ${newState}. Valid transitions: ${VALID_TRANSITIONS[this.currentState].join(', ')}`
      );
    }

    const oldState = this.currentState;
    this.currentState = newState;
    this.transitionHistory.push({
      from: oldState,
      to: newState,
      timestamp: new Date(),
      metadata,
    });

    return {
      oldState,
      newState,
      timestamp: new Date(),
      transitionId: `${this.request._id}-${Date.now()}`,
    };
  }

  getTransitionHistory() {
    return this.transitionHistory;
  }

  canAccept() {
    return this.currentState === 'ASSIGNED';
  }

  canReject() {
    return this.currentState === 'ASSIGNED';
  }

  canMarkEnRoute() {
    return this.currentState === 'ACCEPTED';
  }

  canComplete() {
    return this.currentState === 'EN_ROUTE';
  }
}

module.exports = RequestStateMachine;