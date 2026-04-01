#!/usr/bin/env node
/**
 * Post-Install Script for @juspay/kriya
 *
 * Runs after npm install to set up the project.
 * Handles initial configuration and environment setup.
 *
 * @generated 2026-03-19
 * @owner juspay
 */

const fs = require('fs');

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  // Files to copy if they don't exist
  templates: [
    { from: '.env.example', to: '.env' },
    { from: '.mcp-servers.example.json', to: '.mcp-servers.json' },
  ],

  // Directories to create
  directories: ['docs/memory-bank', '.ai/workflows'],

  // Welcome message
  showWelcome: true,
};

// ============================================================================
// HELPERS
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, type = 'info') {
  // Skip output in CI environments or if explicitly silenced
  if (process.env.CI || process.env.npm_config_loglevel === 'silent') {
    return;
  }

  const prefix = {
    info: `${colors.blue}ℹ${colors.reset}`,
    success: `${colors.green}✔${colors.reset}`,
    warn: `${colors.yellow}⚠${colors.reset}`,
  };

  console.log(`${prefix[type] || prefix.info} ${message}`);
}

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  if (!exists(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  }
  return false;
}

function copyFile(from, to) {
  if (!exists(from)) return false;
  if (exists(to)) return false;

  fs.copyFileSync(from, to);
  return true;
}

// ============================================================================
// SETUP TASKS
// ============================================================================

/**
 * Copy template files.
 */
function setupTemplates() {
  for (const { from, to } of config.templates) {
    if (copyFile(from, to)) {
      log(`Created ${to} from template`, 'success');
    }
  }
}

/**
 * Create required directories.
 */
function setupDirectories() {
  for (const dir of config.directories) {
    if (ensureDir(dir)) {
      log(`Created directory: ${dir}`, 'success');
    }
  }
}

/**
 * Show welcome message.
 */
function showWelcome() {
  if (
    !config.showWelcome ||
    process.env.CI ||
    process.env.npm_config_loglevel === 'silent'
  ) {
    return;
  }

  console.log('');
  console.log(
    `${colors.cyan}${colors.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`
  );
  console.log(
    `${colors.cyan}${colors.bold}  Welcome to @juspay/kriya!${colors.reset}`
  );
  console.log(
    `${colors.cyan}${colors.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`
  );
  console.log('');
  console.log(`${colors.dim}  Quick Start:${colors.reset}`);
  console.log(
    `${colors.dim}  1. Configure your .env file with API keys${colors.reset}`
  );
  console.log(`${colors.dim}  2. Run: npm run build${colors.reset}`);
  console.log(`${colors.dim}  3. Run: npm start${colors.reset}`);
  console.log('');
  console.log(`${colors.dim}  Commands:${colors.reset}`);
  console.log(
    `${colors.dim}  npm run dev        - Start development mode${colors.reset}`
  );
  console.log(`${colors.dim}  npm run test       - Run tests${colors.reset}`);
  console.log(
    `${colors.dim}  npm run lint       - Check code quality${colors.reset}`
  );
  console.log(
    `${colors.dim}  npm run doctor     - Diagnose project setup${colors.reset}`
  );
  console.log('');
  console.log(`${colors.dim}  Documentation: README.md${colors.reset}`);
  console.log(`${colors.dim}  AI Config: CLAUDE.md${colors.reset}`);
  console.log('');
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  try {
    setupTemplates();
    setupDirectories();
    showWelcome();
  } catch (error) {
    // Don't fail install on postinstall errors
    if (process.env.DEBUG) {
      console.error('Postinstall error:', error);
    }
  }
}

main();
