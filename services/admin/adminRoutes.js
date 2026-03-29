// services/admin/adminRoutes.js — Dashboard providers for shared-dashboard
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db, { getSetting, setSetting } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_PATH = join(__dirname, '..', '..', 'data', 'skills.json');

function loadSkills() {
  try { return JSON.parse(readFileSync(SKILLS_PATH, 'utf-8')); }
  catch { return []; }
}
function saveSkills(skills) {
  writeFileSync(SKILLS_PATH, JSON.stringify(skills, null, 2) + '\n', 'utf-8');
}

export const dashboardProviders = {
  async getStats() {
    const skills = loadSkills();
    const totalHosts = db.prepare('SELECT COUNT(*) as c FROM hosts').get().c;
    const activeHosts = db.prepare('SELECT COUNT(*) as c FROM hosts WHERE is_active = 1').get().c;
    const totalAlerts = db.prepare('SELECT COUNT(*) as c FROM alerts').get().c;
    const totalActivations = db.prepare('SELECT COUNT(*) as c FROM shelter_activations').get().c;
    const totalSeekerEvents = db.prepare('SELECT COUNT(*) as c FROM seeker_events').get().c;

    return {
      totalConversations: 0,
      activeSkills: skills.filter(s => s.enabled).length,
      totalHosts,
      activeHosts,
      totalAlerts,
      totalActivations,
      totalSeekerEvents,
    };
  },

  async getConversations() {
    return { conversations: [] };
  },

  async getThread() {
    return { history: [] };
  },

  async getSkills() {
    return { skills: loadSkills() };
  },

  async updateSkill(name, body) {
    const skills = loadSkills();
    const skill = skills.find(s => s.name === name);
    if (!skill) return null;
    if (body.enabled !== undefined) skill.enabled = body.enabled;
    if (body.config !== undefined) skill.config = body.config;
    skill.updated_at = new Date().toISOString();
    saveSkills(skills);
    return skill;
  },

  async getHealth() {
    return { status: 'ok', ts: new Date().toISOString() };
  },

  async getDashboardSettings() {
    try {
      const raw = getSetting('dashboard_settings');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },

  async saveDashboardSettings(settings) {
    setSetting('dashboard_settings', JSON.stringify(settings));
  },
};
