'use strict';

jest.mock('../models/DispatchLog', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../models/Ambulance', () => ({}));
jest.mock('../models/EmergencyRequest', () => ({}));

const { writeAllocation } = require('../utils/dispatchEngine');
const RequestStateMachine = require('../utils/requestStateMachine');

describe('EmergencyRequest assignment state consistency', () => {
  const buildRequest = () => ({
    _id: { toString: () => 'request-1' },
    status: 'PENDING',
    assignmentState: 'PENDING',
    priority: 'MEDIUM',
    save: jest.fn().mockResolvedValue(undefined),
  });

  it('writes PENDING to ASSIGNED in both fields and the state machine observes it', async () => {
    const request = buildRequest();
    const ambulance = { _id: 'ambulance-1', plateNumber: 'AMB-1' };

    await writeAllocation(request, ambulance, null, false);

    expect(request.status).toBe('ASSIGNED');
    expect(request.assignmentState).toBe('ASSIGNED');

    const stateMachine = new RequestStateMachine(request);
    expect(stateMachine.currentState).toBe('ASSIGNED');
    expect(stateMachine.canAccept()).toBe(true);
  });

  it('keeps ASSIGNED to ACCEPTED mirrored in both fields', async () => {
    const request = {
      _id: { toString: () => 'request-1' },
      status: 'ASSIGNED',
      assignmentState: 'ASSIGNED',
      priority: 'MEDIUM',
      save: jest.fn().mockResolvedValue(undefined),
    };

    const stateMachine = new RequestStateMachine(request);
    await stateMachine.transitionTo('ACCEPTED');

    expect(stateMachine.currentState).toBe('ACCEPTED');
    expect(request.status).toBe('ACCEPTED');
    expect(request.assignmentState).toBe('ACCEPTED');
  });

  it('keeps rejection authoritative in assignmentState while public status returns to PENDING', async () => {
    const request = {
      _id: { toString: () => 'request-1' },
      status: 'ASSIGNED',
      assignmentState: 'ASSIGNED',
      priority: 'MEDIUM',
      save: jest.fn().mockResolvedValue(undefined),
    };

    const stateMachine = new RequestStateMachine(request);
    await stateMachine.transitionTo('REJECTED');

    expect(stateMachine.currentState).toBe('REJECTED');
    expect(request.assignmentState).toBe('REJECTED');
    expect(request.status).toBe('PENDING');
  });
});
