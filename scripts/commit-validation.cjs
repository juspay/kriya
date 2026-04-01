#!/usr/bin/env node

/**
 * Commit Message Validation Script
 * Validates commit messages against semantic commit conventions
 *
 * Usage:
 *   node commit-validation.cjs [commit-message]
 *   Or set COMMIT_MSG environment variable
 *   Or reads from git commit message file
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Semantic commit types
const SEMANTIC_TYPES = [
  'feat', // New feature
  'fix', // Bug fix
  'docs', // Documentation changes
  'style', // Code style changes (formatting, semicolons, etc.)
  'refactor', // Code refactoring without feature/fix
  'test', // Adding or updating tests
  'chore', // Maintenance tasks
  'perf', // Performance improvements
  'ci', // CI/CD changes
  'build', // Build system changes
  'revert', // Reverting previous commits
  'wip', // Work in progress
  'hotfix', // Critical production fixes
];

// Semantic commit pattern: type(scope): description
const SEMANTIC_COMMIT_PATTERN = /^([a-z]+)(\([a-zA-Z0-9\-\/]+\))?:\s(.+)$/i;

// ANSI color codes
const COLORS = {
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

class CommitValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.startTime = Date.now();
  }

  /**
   * Log a message with optional color
   * @param {string} message - Message to log
   * @param {string} color - Color key from COLORS
   */
  log(message, color = 'reset') {
    const colorCode = COLORS[color] || COLORS.reset;
    console.log(`${colorCode}${message}${COLORS.reset}`);
  }

  /**
   * Add an error message
   * @param {string} message - Error message
   */
  addError(message) {
    this.errors.push(message);
  }

  /**
   * Add a warning message
   * @param {string} message - Warning message
   */
  addWarning(message) {
    this.warnings.push(message);
  }

  /**
   * Get the commit message from various sources
   * @returns {string|null} The commit message or null if not found
   */
  getCommitMessage() {
    // 1. Check command line arguments
    if (process.argv[2]) {
      // Could be a file path (from git hook) or direct message
      const arg = process.argv[2];
      if (fs.existsSync(arg)) {
        try {
          return fs.readFileSync(arg, 'utf8').trim();
        } catch (err) {
          this.log(
            `Warning: Could not read commit message file: ${arg}`,
            'yellow'
          );
        }
      }
      return arg;
    }

    // 2. Check COMMIT_MSG_FILE environment variable (set by husky hook)
    if (
      process.env.COMMIT_MSG_FILE &&
      fs.existsSync(process.env.COMMIT_MSG_FILE)
    ) {
      try {
        return fs.readFileSync(process.env.COMMIT_MSG_FILE, 'utf8').trim();
      } catch (err) {
        // Fall through to other methods
      }
    }

    // 3. Check COMMIT_MSG environment variable
    if (process.env.COMMIT_MSG) {
      return process.env.COMMIT_MSG;
    }

    // 3. Try to get from git (last commit message)
    try {
      const message = execSync('git log -1 --pretty=%B', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return message;
    } catch (err) {
      // Git command failed, likely no commits yet
    }

    // 4. Check for .git/COMMIT_EDITMSG
    const gitDir = this.findGitDir();
    if (gitDir) {
      const commitMsgFile = path.join(gitDir, 'COMMIT_EDITMSG');
      if (fs.existsSync(commitMsgFile)) {
        try {
          return fs.readFileSync(commitMsgFile, 'utf8').trim();
        } catch (err) {
          // Could not read file
        }
      }
    }

    return null;
  }

  /**
   * Find the .git directory
   * @returns {string|null} Path to .git directory or null
   */
  findGitDir() {
    let dir = process.cwd();
    while (dir !== path.dirname(dir)) {
      const gitPath = path.join(dir, '.git');
      if (fs.existsSync(gitPath)) {
        return gitPath;
      }
      dir = path.dirname(dir);
    }
    return null;
  }

  /**
   * Validate semantic commit format
   * @param {string} message - Commit message to validate
   * @returns {boolean} True if valid
   */
  validateSemanticFormat(message) {
    // Extract first line (subject)
    const subject = message.split('\n')[0].trim();

    // Check against semantic pattern
    const match = subject.match(SEMANTIC_COMMIT_PATTERN);

    if (!match) {
      this.addError(
        'Commit message does not follow semantic format: type(scope): description'
      );
      this.addError(`  Received: "${subject}"`);
      return false;
    }

    const [, type, scope, description] = match;
    const typeLower = type.toLowerCase();

    // Validate type
    if (!SEMANTIC_TYPES.includes(typeLower)) {
      this.addError(`Invalid commit type: "${type}"`);
      this.addError(`  Valid types: ${SEMANTIC_TYPES.join(', ')}`);
      return false;
    }

    // Validate description is not empty
    if (!description || description.trim().length === 0) {
      this.addError('Commit description cannot be empty');
      return false;
    }

    // Validate description length (should be concise)
    if (description.length > 100) {
      this.addWarning(
        `Description is too long (${description.length} chars). Consider keeping it under 100 characters.`
      );
    }

    // Validate description starts with lowercase (convention)
    if (
      description[0] === description[0].toUpperCase() &&
      description[0] !== description[0].toLowerCase()
    ) {
      this.addWarning('Description should start with lowercase letter');
    }

    // Validate no period at end
    if (description.endsWith('.')) {
      this.addWarning('Description should not end with a period');
    }

    return true;
  }

  /**
   * Validate commit message quality
   * @param {string} message - Commit message to validate
   * @returns {boolean} True if passes quality checks
   */
  validateCommitQuality(message) {
    const subject = message.split('\n')[0].trim();
    let isValid = true;

    // Anti-patterns to check
    const antiPatterns = [
      {
        pattern: /^(fix|update|change|modify)$/i,
        reason: 'Too vague - describe what was fixed/updated',
      },
      { pattern: /^wip$/i, reason: 'WIP commits should include a description' },
      { pattern: /^\.+$/, reason: 'Commit message cannot be just dots' },
      { pattern: /^-+$/, reason: 'Commit message cannot be just dashes' },
      {
        pattern: /^\s*$/,
        reason: 'Commit message cannot be empty or whitespace',
      },
      {
        pattern: /^(asdf|qwerty|test123|aaa+|xxx+)$/i,
        reason: 'Placeholder commit messages are not allowed',
      },
      {
        pattern: /^fixup!/i,
        reason: 'Fixup commits should be squashed before merging',
      },
      {
        pattern: /^squash!/i,
        reason: 'Squash commits should be squashed before merging',
      },
    ];

    for (const { pattern, reason } of antiPatterns) {
      if (pattern.test(subject)) {
        this.addError(`Anti-pattern detected: ${reason}`);
        isValid = false;
      }
    }

    // Check for minimum meaningful length
    const match = subject.match(SEMANTIC_COMMIT_PATTERN);
    const description = match ? match[3] : null;
    if (description && description.length < 3) {
      this.addWarning(
        'Description is very short. Consider being more descriptive.'
      );
    }

    // Check for common typos in types
    const commonTypos = {
      feat: ['feature', 'feat:', 'feta', 'feat.'],
      fix: ['fixed', 'fixes', 'fxi', 'fix:'],
      docs: ['doc', 'documentation', 'docs:'],
      chore: ['chores', 'chor', 'chore:'],
      refactor: ['refact', 'refacor', 'refactor:'],
    };

    const firstWord = subject.split(/[(:]/)[0].toLowerCase();
    for (const [correct, typos] of Object.entries(commonTypos)) {
      if (typos.includes(firstWord) && firstWord !== correct) {
        this.addWarning(`Did you mean "${correct}" instead of "${firstWord}"?`);
      }
    }

    return isValid;
  }

  /**
   * Check if commit is a special type that should skip validation
   * @param {string} message - Commit message
   * @returns {boolean} True if special commit
   */
  isSpecialCommit(message) {
    const subject = message.split('\n')[0].trim().toLowerCase();

    // Merge commits
    if (subject.startsWith('merge ') || subject.startsWith('merge:')) {
      this.log('Skipping validation for merge commit', 'cyan');
      return true;
    }

    // Revert commits
    if (subject.startsWith('revert ') || subject.startsWith('revert:')) {
      this.log('Skipping validation for revert commit', 'cyan');
      return true;
    }

    // Initial commit
    if (
      subject === 'initial commit' ||
      subject === 'init' ||
      subject === 'first commit'
    ) {
      this.log('Skipping validation for initial commit', 'cyan');
      return true;
    }

    // Release commits (often auto-generated)
    if (
      subject.match(/^chore\(release\):/i) ||
      subject.match(/^\d+\.\d+\.\d+/)
    ) {
      this.log('Skipping validation for release commit', 'cyan');
      return true;
    }

    return false;
  }

  /**
   * Provide helpful examples of valid commits
   */
  provideExamples() {
    this.log('\n📝 Valid commit message examples:', 'cyan');
    this.log('', 'reset');

    const examples = [
      {
        msg: 'feat(auth): add OAuth2 login support',
        desc: 'New feature with scope',
      },
      {
        msg: 'fix(api): resolve null pointer in user service',
        desc: 'Bug fix with scope',
      },
      {
        msg: 'docs: update README installation steps',
        desc: 'Documentation without scope',
      },
      {
        msg: 'refactor(core): simplify error handling logic',
        desc: 'Code refactoring',
      },
      {
        msg: 'test(utils): add unit tests for date helpers',
        desc: 'Adding tests',
      },
      {
        msg: 'chore(deps): upgrade lodash to v4.17.21',
        desc: 'Maintenance task',
      },
      {
        msg: 'perf(db): optimize query execution time',
        desc: 'Performance improvement',
      },
      { msg: 'ci: add GitHub Actions workflow', desc: 'CI/CD changes' },
      {
        msg: 'build: configure webpack for production',
        desc: 'Build system changes',
      },
      {
        msg: 'hotfix(payment): fix critical checkout bug',
        desc: 'Critical fix',
      },
    ];

    for (const { msg, desc } of examples) {
      this.log(`  ${COLORS.green}${msg}${COLORS.reset}`, 'reset');
      this.log(`    ${COLORS.dim}${desc}${COLORS.reset}`, 'reset');
    }

    this.log('\n📋 Commit message format:', 'cyan');
    this.log('  type(scope): description', 'white');
    this.log('', 'reset');
    this.log(
      `  ${COLORS.dim}type${COLORS.reset}    - One of: ${SEMANTIC_TYPES.join(', ')}`,
      'reset'
    );
    this.log(
      `  ${COLORS.dim}scope${COLORS.reset}   - Optional context (e.g., component name)`,
      'reset'
    );
    this.log(
      `  ${COLORS.dim}description${COLORS.reset} - Brief summary of the change`,
      'reset'
    );
  }

  /**
   * Print validation results
   */
  printResults() {
    const duration = Date.now() - this.startTime;

    console.log('');
    this.log('─'.repeat(60), 'dim');

    if (this.errors.length === 0 && this.warnings.length === 0) {
      this.log('✅ Commit message validation passed!', 'green');
    } else {
      if (this.errors.length > 0) {
        this.log(`\n❌ Errors (${this.errors.length}):`, 'red');
        for (const error of this.errors) {
          this.log(`   • ${error}`, 'red');
        }
      }

      if (this.warnings.length > 0) {
        this.log(`\n⚠️  Warnings (${this.warnings.length}):`, 'yellow');
        for (const warning of this.warnings) {
          this.log(`   • ${warning}`, 'yellow');
        }
      }
    }

    this.log('─'.repeat(60), 'dim');
    this.log(`Validation completed in ${duration}ms`, 'dim');
  }

  /**
   * Main execution method
   * @returns {number} Exit code (0 for success, 1 for failure)
   */
  run() {
    this.log('\n🔍 Commit Message Validator', 'bold');
    this.log('─'.repeat(60), 'dim');

    // Get commit message
    const message = this.getCommitMessage();

    if (!message) {
      this.addError('No commit message found');
      this.log('\nUsage:', 'cyan');
      this.log('  node commit-validation.cjs <commit-message>', 'white');
      this.log(
        '  node commit-validation.cjs <path-to-commit-msg-file>',
        'white'
      );
      this.log(
        '  COMMIT_MSG="your message" node commit-validation.cjs',
        'white'
      );
      this.printResults();
      return 1;
    }

    this.log(`\nValidating: "${message.split('\n')[0]}"`, 'white');

    // Check for special commits that skip validation
    if (this.isSpecialCommit(message)) {
      this.printResults();
      return 0;
    }

    // Run validations
    const formatValid = this.validateSemanticFormat(message);
    const qualityValid = this.validateCommitQuality(message);

    // Print results
    this.printResults();

    // Provide examples if validation failed
    if (this.errors.length > 0) {
      this.provideExamples();
    }

    // Return exit code
    return this.errors.length > 0 ? 1 : 0;
  }
}

// Run validator
const validator = new CommitValidator();
const exitCode = validator.run();
process.exit(exitCode);
