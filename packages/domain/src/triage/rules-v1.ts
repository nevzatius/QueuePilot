import type { RuleSet } from './types.js';

/**
 * Service-request triage, version 1. Frozen: edit a copy under a new version instead.
 * SLA values are minutes to first action (dispatch, callback or confirmation).
 */
export const RULES_V1: RuleSet = {
  version: 'triage-v1',
  rules: {
    // Vehicle breakdowns: a safety risk on a highway is the most urgent case in the catalogue.
    roadside_assistance: [
      { when: { safetyRisk: true, locationType: ['highway'] }, lane: 'emergency', slaTargetMinutes: 30, team: 'roadside-highway' },
      { when: { safetyRisk: true }, lane: 'emergency', slaTargetMinutes: 45, team: 'roadside-rapid' },
      { when: { locationType: ['highway'] }, lane: 'standard', slaTargetMinutes: 60, team: 'roadside-highway' },
      { when: { locationType: ['rural'] }, lane: 'standard', slaTargetMinutes: 120, team: 'roadside-rural' },
      { when: { priority: ['high', 'urgent'] }, lane: 'standard', slaTargetMinutes: 60, team: 'roadside-urban' },
      { when: {}, lane: 'standard', slaTargetMinutes: 90, team: 'roadside-urban' },
    ],
    // On-site repairs (utilities, appliances, HVAC). A requested window means the customer books a visit.
    technical_service: [
      { when: { safetyRisk: true }, lane: 'emergency', slaTargetMinutes: 120, team: 'field-service-priority' },
      { when: { priority: ['urgent'] }, lane: 'standard', slaTargetMinutes: 240, team: 'field-service' },
      { when: { preferredWindow: ['morning', 'afternoon', 'evening'] }, lane: 'scheduled', slaTargetMinutes: 2880, team: 'field-service-scheduled' },
      { when: { priority: ['high'] }, lane: 'standard', slaTargetMinutes: 480, team: 'field-service' },
      { when: {}, lane: 'standard', slaTargetMinutes: 1440, team: 'field-service' },
    ],
    // Clinics and consultations: always scheduled, routed by the preferred window.
    appointment: [
      { when: { priority: ['urgent'] }, lane: 'standard', slaTargetMinutes: 120, team: 'scheduling-priority' },
      { when: { preferredWindow: ['morning'] }, lane: 'scheduled', slaTargetMinutes: 1440, team: 'scheduling-am' },
      { when: { preferredWindow: ['afternoon'] }, lane: 'scheduled', slaTargetMinutes: 1440, team: 'scheduling-pm' },
      { when: { preferredWindow: ['evening'] }, lane: 'scheduled', slaTargetMinutes: 1440, team: 'scheduling-evening' },
      { when: {}, lane: 'scheduled', slaTargetMinutes: 2880, team: 'scheduling-flex' },
    ],
    // IT and customer support desks.
    support_ticket: [
      { when: { safetyRisk: true }, lane: 'emergency', slaTargetMinutes: 60, team: 'support-l2' },
      { when: { priority: ['urgent'] }, lane: 'standard', slaTargetMinutes: 60, team: 'support-l2' },
      { when: { priority: ['high'] }, lane: 'standard', slaTargetMinutes: 240, team: 'support-l1' },
      { when: { priority: ['low'] }, lane: 'scheduled', slaTargetMinutes: 2880, team: 'support-l1' },
      { when: {}, lane: 'standard', slaTargetMinutes: 480, team: 'support-l1' },
    ],
    // Hospitality and travel reservations.
    booking: [
      { when: { priority: ['urgent'] }, lane: 'standard', slaTargetMinutes: 120, team: 'reservations-priority' },
      { when: {}, lane: 'scheduled', slaTargetMinutes: 1440, team: 'reservations' },
    ],
    general: [
      { when: { safetyRisk: true }, lane: 'emergency', slaTargetMinutes: 60, team: 'triage-desk' },
      { when: { priority: ['high', 'urgent'] }, lane: 'standard', slaTargetMinutes: 240, team: 'triage-desk' },
      { when: {}, lane: 'standard', slaTargetMinutes: 1440, team: 'triage-desk' },
    ],
  },
  score: {
    priority: { low: 10, normal: 30, high: 55, urgent: 75 },
    safetyRisk: 25,
    locationType: { highway: 10, rural: 5, urban: 0 },
    type: {
      roadside_assistance: 5,
      technical_service: 0,
      appointment: -10,
      support_ticket: 0,
      booking: -10,
      general: 0,
    },
  },
};
