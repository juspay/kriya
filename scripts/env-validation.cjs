#!/usr/bin/env node

/**
 * Environment Configuration Validator
 * Validates .env files against .env.example and scans codebase for undocumented env vars
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

class EnvironmentValidator {
  constructor() {
    this.issues = [];
    this.warnings = [];
    this.startTime = Date.now();
    this.projectRoot = process.cwd();
    this.envExampleVars = new Map();
    this.envVars = new Map();
    this.codeEnvVars = new Set();
  }

  /**
   * Log a message with optional color
   * @param {string} message - Message to log
   * @param {string} color - Color name from colors object
   */
  log(message, color = 'white') {
    const colorCode = colors[color] || colors.white;
    console.log(`${colorCode}${message}${colors.reset}`);
  }

  /**
   * Add an issue or warning to the results
   * @param {'critical'|'warning'|'info'} severity - Issue severity
   * @param {string} category - Category of the issue
   * @param {string} message - Description of the issue
   * @param {string} suggestion - Suggested fix
   */
  addIssue(severity, category, message, suggestion = '') {
    const issue = { severity, category, message, suggestion };
    if (severity === 'critical') {
      this.issues.push(issue);
    } else {
      this.warnings.push(issue);
    }
  }

  /**
   * Parse .env.example file and extract all environment variables
   * @returns {Map<string, object>} Map of variable names to their metadata
   */
  parseEnvExample() {
    const envExamplePath = path.join(this.projectRoot, '.env.example');

    if (!fs.existsSync(envExamplePath)) {
      this.addIssue('warning', 'Configuration', 'No .env.example file found', 'Create a .env.example file to document required environment variables');
      return this.envExampleVars;
    }

    const content = fs.readFileSync(envExamplePath, 'utf-8');
    const lines = content.split('\n');
    let currentSection = 'General';
    let lineNumber = 0;

    for (const line of lines) {
      lineNumber++;
      const trimmedLine = line.trim();

      // Skip empty lines
      if (!trimmedLine) continue;

      // Check for section comments
      if (trimmedLine.startsWith('#') && trimmedLine.includes('---')) {
        currentSection = trimmedLine.replace(/#/g, '').replace(/-/g, '').trim() || 'General';
        continue;
      }

      // Skip regular comments
      if (trimmedLine.startsWith('#')) continue;

      // Parse environment variable
      const match = trimmedLine.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) {
        const [, name, value] = match;
        this.envExampleVars.set(name, {
          name,
          exampleValue: value,
          section: currentSection,
          lineNumber,
          required: !trimmedLine.includes('optional'),
        });
      }
    }

    return this.envExampleVars;
  }

  /**
   * Parse actual .env file
   * @returns {Map<string, string>} Map of variable names to values
   */
  parseEnvFile() {
    const envPath = path.join(this.projectRoot, '.env');

    if (!fs.existsSync(envPath)) {
      this.addIssue('warning', 'Configuration', 'No .env file found', 'Copy .env.example to .env and fill in your values');
      return this.envVars;
    }

    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) continue;

      const match = trimmedLine.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) {
        const [, name, value] = match;
        // Remove surrounding quotes if present
        const cleanValue = value.replace(/^["']|["']$/g, '');
        this.envVars.set(name, cleanValue);
      }
    }

    return this.envVars;
  }

  /**
   * Validate a single environment variable
   * @param {string} name - Variable name
   * @param {string} value - Variable value
   * @param {string} section - Section category
   * @param {number} lineNumber - Line number in file
   */
  validateEnvVariable(name, value, section = 'General', lineNumber = 0) {
    // Check for empty values
    if (!value || value === '""' || value === "''") {
      this.addIssue('critical', section, `${name} is empty or not set`, `Provide a valid value for ${name}`);
      return;
    }

    // Check for placeholder values
    const placeholderPatterns = [
      /^your[_-]?/i,
      /^<.*>$/,
      /^\[.*\]$/,
      /^xxx+$/i,
      /^placeholder$/i,
      /^change[_-]?me$/i,
      /^todo$/i,
      /^fixme$/i,
      /^example$/i,
    ];

    for (const pattern of placeholderPatterns) {
      if (pattern.test(value)) {
        this.addIssue('critical', section, `${name} contains a placeholder value: "${value}"`, `Replace with actual value for ${name}`);
        return;
      }
    }

    // Validate API keys
    if (name.includes('OPENAI') && name.includes('KEY')) {
      if (!value.startsWith('sk-') && !value.startsWith('sk-proj-') && !value.startsWith('sk-admin-')) {
        this.addIssue('warning', section, `${name} doesn't match expected OpenAI API key format (should start with 'sk-', 'sk-proj-', or 'sk-admin-')`, 'Verify your OpenAI API key is correct');
      }
    }

    if (name.includes('ANTHROPIC') && name.includes('KEY')) {
      if (!value.startsWith('sk-ant-')) {
        this.addIssue('warning', section, `${name} doesn't match expected Anthropic API key format (should start with 'sk-ant-')`, 'Verify your Anthropic API key is correct');
      }
    }

    // Validate URLs
    if (name.includes('URL') || name.includes('ENDPOINT') || name.includes('HOST')) {
      const hasValidScheme = /^(https?|postgres|mysql|mongodb|redis|amqp|ws|wss|ftp|ssh|file):\/\//.test(value);
      if (value && !hasValidScheme && !value.startsWith('localhost') && !value.match(/^\d+\.\d+\.\d+\.\d+/)) {
        this.addIssue('warning', section, `${name} doesn't appear to be a valid URL: "${value}"`, 'URLs should start with http:// or https://');
      }
    }

    // Validate boolean values
    if (name.includes('ENABLED') || name.includes('DISABLED') || name.includes('DEBUG') || name.startsWith('IS_') || name.startsWith('HAS_') || name.startsWith('USE_')) {
      const validBooleans = ['true', 'false', '1', '0', 'yes', 'no'];
      if (!validBooleans.includes(value.toLowerCase())) {
        this.addIssue('warning', section, `${name} should be a boolean value, got: "${value}"`, 'Use true/false, 1/0, or yes/no');
      }
    }

    // Validate port numbers
    if (name.includes('PORT')) {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        this.addIssue('critical', section, `${name} has invalid port number: "${value}"`, 'Port must be a number between 1 and 65535');
      }
    }

    // Validate NODE_ENV
    if (name === 'NODE_ENV') {
      const validEnvs = ['development', 'production', 'test', 'staging'];
      if (!validEnvs.includes(value.toLowerCase())) {
        this.addIssue('warning', section, `${name} has non-standard value: "${value}"`, `Consider using one of: ${validEnvs.join(', ')}`);
      }
    }

    // Check for secrets in wrong format
    if ((name.includes('SECRET') || name.includes('PASSWORD') || name.includes('TOKEN')) && value.length < 8) {
      this.addIssue('warning', section, `${name} seems too short for a secret (${value.length} chars)`, 'Secrets should typically be at least 8 characters');
    }
  }

  /**
   * Get all source files in the project
   * @returns {string[]} Array of file paths
   */
  getSourceFiles() {
    const sourceFiles = [];
    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', 'vendor'];
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];

    const walkDir = (dir) => {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);

          if (stat.isDirectory()) {
            if (!ignoreDirs.includes(file) && !file.startsWith('.')) {
              walkDir(filePath);
            }
          } else if (extensions.some((ext) => file.endsWith(ext))) {
            sourceFiles.push(filePath);
          }
        }
      } catch (err) {
        // Skip directories we can't read
      }
    };

    walkDir(this.projectRoot);
    return sourceFiles;
  }

  /**
   * Extract environment variables used in source code
   * @returns {Set<string>} Set of environment variable names
   */
  extractEnvVarsFromCode() {
    const sourceFiles = this.getSourceFiles();
    const envVarPatterns = [
      /process\.env\.([A-Z_][A-Z0-9_]*)/g,
      /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
      /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
      /Deno\.env\.get\(['"]([A-Z_][A-Z0-9_]*)['"]\)/g,
    ];

    for (const filePath of sourceFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');

        for (const pattern of envVarPatterns) {
          let match;
          // Reset lastIndex for global regex
          pattern.lastIndex = 0;
          while ((match = pattern.exec(content)) !== null) {
            this.codeEnvVars.add(match[1]);
          }
        }
      } catch (err) {
        // Skip files we can't read
      }
    }

    return this.codeEnvVars;
  }

  /**
   * Check for missing environment variables (used in code but not documented)
   */
  checkMissingEnvVars() {
    this.extractEnvVarsFromCode();

    // Skip common Node.js built-in env vars
    const builtInVars = new Set(['NODE_ENV', 'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TERM', 'LANG', 'TZ', 'CI', 'npm_package_version', 'npm_package_name']);

    for (const envVar of this.codeEnvVars) {
      if (!this.envExampleVars.has(envVar) && !builtInVars.has(envVar)) {
        this.addIssue(
          'warning',
          'Documentation',
          `Environment variable ${envVar} is used in code but not documented in .env.example`,
          `Add ${envVar} to .env.example with a description`
        );
      }
    }

    // Check for documented vars not used in code
    for (const [name] of this.envExampleVars) {
      if (!this.codeEnvVars.has(name) && !builtInVars.has(name)) {
        this.addIssue('info', 'Documentation', `Environment variable ${name} is documented but may not be used in code`, 'Verify if this variable is still needed');
      }
    }
  }

  /**
   * Check for consistency between .env.example and .env
   */
  checkEnvironmentConsistency() {
    // Check for vars in .env.example but missing from .env
    for (const [name, meta] of this.envExampleVars) {
      if (!this.envVars.has(name)) {
        if (meta.required) {
          this.addIssue('critical', 'Missing', `Required variable ${name} is missing from .env`, `Add ${name} to your .env file`);
        } else {
          this.addIssue('info', 'Missing', `Optional variable ${name} is not set in .env`, `Consider adding ${name} if needed`);
        }
      }
    }

    // Check for vars in .env but not in .env.example
    for (const [name] of this.envVars) {
      if (!this.envExampleVars.has(name)) {
        this.addIssue('warning', 'Undocumented', `Variable ${name} in .env is not documented in .env.example`, `Add ${name} to .env.example for documentation`);
      }
    }
  }

  /**
   * Print the validation results
   */
  printResults() {
    const duration = Date.now() - this.startTime;

    console.log('\n');
    this.log('=' .repeat(60), 'cyan');
    this.log('  Environment Validation Results', 'bold');
    this.log('=' .repeat(60), 'cyan');
    console.log('\n');

    // Print critical issues
    if (this.issues.length > 0) {
      this.log(`  ${colors.bold}Critical Issues (${this.issues.length})${colors.reset}`, 'red');
      this.log('-'.repeat(40), 'red');
      for (const issue of this.issues) {
        this.log(`  [${issue.category}] ${issue.message}`, 'red');
        if (issue.suggestion) {
          this.log(`    -> ${issue.suggestion}`, 'dim');
        }
      }
      console.log('\n');
    }

    // Print warnings
    const warnings = this.warnings.filter((w) => w.severity === 'warning');
    if (warnings.length > 0) {
      this.log(`  ${colors.bold}Warnings (${warnings.length})${colors.reset}`, 'yellow');
      this.log('-'.repeat(40), 'yellow');
      for (const warning of warnings) {
        this.log(`  [${warning.category}] ${warning.message}`, 'yellow');
        if (warning.suggestion) {
          this.log(`    -> ${warning.suggestion}`, 'dim');
        }
      }
      console.log('\n');
    }

    // Print info
    const infos = this.warnings.filter((w) => w.severity === 'info');
    if (infos.length > 0) {
      this.log(`  ${colors.bold}Info (${infos.length})${colors.reset}`, 'blue');
      this.log('-'.repeat(40), 'blue');
      for (const info of infos) {
        this.log(`  [${info.category}] ${info.message}`, 'blue');
        if (info.suggestion) {
          this.log(`    -> ${info.suggestion}`, 'dim');
        }
      }
      console.log('\n');
    }

    // Summary
    this.log('=' .repeat(60), 'cyan');
    this.log('  Summary', 'bold');
    this.log('=' .repeat(60), 'cyan');

    const totalVars = this.envExampleVars.size;
    const setVars = this.envVars.size;
    const codeVars = this.codeEnvVars.size;

    this.log(`  Documented variables:     ${totalVars}`, 'white');
    this.log(`  Variables in .env:        ${setVars}`, 'white');
    this.log(`  Variables used in code:   ${codeVars}`, 'white');
    this.log(`  Critical issues:          ${this.issues.length}`, this.issues.length > 0 ? 'red' : 'green');
    this.log(`  Warnings:                 ${warnings.length}`, warnings.length > 0 ? 'yellow' : 'green');
    this.log(`  Completed in:             ${duration}ms`, 'dim');

    console.log('\n');

    if (this.issues.length === 0 && warnings.length === 0) {
      this.log('  All environment variables are properly configured!', 'green');
    } else if (this.issues.length === 0) {
      this.log('  No critical issues found, but review warnings above.', 'yellow');
    } else {
      this.log('  Please fix critical issues before proceeding.', 'red');
    }

    console.log('\n');
  }

  /**
   * Main execution method
   * @returns {number} Exit code (0 for success, 1 for critical issues)
   */
  run() {
    this.log('\nEnvironment Configuration Validator', 'cyan');
    this.log('Scanning project: ' + this.projectRoot, 'dim');
    console.log('\n');

    // Parse environment files
    this.log('Parsing .env.example...', 'dim');
    this.parseEnvExample();

    this.log('Parsing .env...', 'dim');
    this.parseEnvFile();

    // Validate each variable in .env
    this.log('Validating environment variables...', 'dim');
    for (const [name, value] of this.envVars) {
      const meta = this.envExampleVars.get(name) || {};
      this.validateEnvVariable(name, value, meta.section, meta.lineNumber);
    }

    // Check consistency
    this.log('Checking consistency between files...', 'dim');
    this.checkEnvironmentConsistency();

    // Check for undocumented vars in code
    this.log('Scanning source code for environment variable usage...', 'dim');
    this.checkMissingEnvVars();

    // Print results
    this.printResults();

    // Return exit code
    return this.issues.length > 0 ? 1 : 0;
  }
}

// Run validator
const validator = new EnvironmentValidator();
const exitCode = validator.run();
process.exit(exitCode);
