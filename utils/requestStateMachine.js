'use strict';

/**
 * Request State Machine
 * Strict state transitions with validation
 * PENDING → ASSIGNED → ACCEPTED → EN_ROUTE → COMPLETED
 * ASSIGNED → REJECTED (driver rejects)
 */

const { REQUEST_STATUS, AMBULANCE_STATUS } = require('./constants');

const STATUS_BACKED_ASSIGNMENT_STATES = new Set([
  REQUEST_STATUS.PENDING,
  REQUEST_STATUS.ASSIGNED,
  REQUEST_STATUS.ACCEPTED,
  REQUEST_STATUS.EN_ROUTE,
  REQUEST_STATUS.COMPLETED,
  REQUEST_STATUS.CANCELLED,
]);

const STATUS_FOR_ASSIGNMENT_STATE = Object.freeze({
  REJECTED: REQUEST_STATUS.PENDING,
});

const publicStatusForAssignmentState = (state) => {
  if (STATUS_BACKED_ASSIGNMENT_STATES.has(state)) return state;
  return STATUS_FOR_ASSIGNMENT_STATE[state];
};

/** Keep assignmentState authoritative while mirroring compatible public status. */
const syncRequestState = (request, state) => {
  request.assignmentState = state;
  const status = publicStatusForAssignmentState(state);
  if (status) {
    request.status = status;
  }
  return request;
};

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
    this.currentState = request.assignmentState || request.status;
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
    syncRequestState(this.request, newState);
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
module.exports.syncRequestState = syncRequestState;
module.exports.publicStatusForAssignmentState = publicStatusForAssignmentState;
