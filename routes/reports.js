import { Router } from 'express';
import {
  rlReportsOverview,
  rlReportsGeneral,
  rlReportsExport,
} from '../middlewares/rateLimits.js';
import * as ctrl from '../controllers/reports.js';
const r = Router();

// Main reports endpoints
r.get('/overview', rlReportsOverview, ctrl.overview);
r.get('/kpis', rlReportsGeneral, ctrl.kpis);

// Specific report types
r.get('/campaigns', rlReportsGeneral, ctrl.campaigns);
r.get('/campaigns/:id', rlReportsGeneral, ctrl.campaignById);
r.get('/automations', rlReportsGeneral, ctrl.automations);
r.get('/messaging', rlReportsGeneral, ctrl.messaging);
r.get('/credits', rlReportsGeneral, ctrl.credits);
r.get('/contacts', rlReportsGeneral, ctrl.contacts);

// Export functionality
r.get('/export', rlReportsExport, ctrl.exportData);

export default r;
