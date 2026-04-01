#!/usr/bin/env node

/**
 * Build Validation Script
 *
 * Pre-build checks to catch common issues before they reach production.
 * Run this as part of your CI/CD pipeline or pre-commit hooks.
 *
 * Usage:
 *   node scripts/build-validations.cjs
 *
 * Environment Variables:
 *   BUILD_VALIDATION_STRICT=true  - Treat warnings as errors
 *   BUILD_VALIDATION_VERBOSE=true - Show detailed output
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

// Symbols for output
const symbols = {
  success: `${colors.green}✓${colors.reset}`,
  error: `${colors.red}✗${colors.reset}`,
  warning: `${colors.yellow}⚠${colors.reset}`,
  info: `${colors.blue}ℹ${colors.reset}`,
  bullet: `${colors.dim}•${colors.reset}`,
};

class BuildValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.rootDir = process.cwd();
    this.fileCache = new Map();
    this.verbose = process.env.BUILD_VALIDATION_VERBOSE === 'true';
    this.strict = process.env.BUILD_VALIDATION_STRICT === 'true';

    // Configuration - customize these for your project
    this.config = {
      // Directories to scan for source files
      sourceDirs: ['src'],

      // Files/directories to exclude from checks
      excludePatterns: [
        'node_modules',
        'dist',
        'build',
        'coverage',
        '.git',
        '*.test.*',
        '*.spec.*',
        '__tests__',
        '__mocks__',
      ],

      // Files that are allowed to have console statements
      allowedConsoleFiles: ['logger', 'logging', 'debug', 'cli', 'console'],

      // Required scripts in package.json
      requiredScripts: ['build', 'test', 'lint', 'format'],

      // Required project directories
      requiredDirs: ['src'],

      // Required project files
      requiredFiles: ['package.json', 'tsconfig.json'],

      // Patterns that might indicate leaked secrets
      secretPatterns: [
        /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]+['"]/gi,
        /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi,
        /(?:token|auth)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi,
        /-----BEGIN (?:RSA |DSA |EC )?PRIVATE KEY-----/gi,
        /(?:aws[_-]?access[_-]?key|aws[_-]?secret)/gi,
      ],
    };
  }

  /**
   * Log a message with optional formatting
   */
  log(message, type = 'info') {
    const prefix = {
      info: symbols.info,
      success: symbols.success,
      error: symbols.error,
      warning: symbols.warning,
      bullet: symbols.bullet,
    };
    console.log(`  ${prefix[type] || ''} ${message}`);
  }

  /**
   * Log verbose messages only when verbose mode is enabled
   */
  logVerbose(message) {
    if (this.verbose) {
      console.log(`    ${colors.dim}${message}${colors.reset}`);
    }
  }

  /**
   * Print a section header
   */
  printHeader(title) {
    console.log();
    console.log(`${colors.bold}${colors.cyan}▸ ${title}${colors.reset}`);
  }

  /**
   * Read file contents with caching
   */
  readFileWithCache(filePath) {
    if (this.fileCache.has(filePath)) {
      return this.fileCache.get(filePath);
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.fileCache.set(filePath, content);
      return content;
    } catch (error) {
      this.logVerbose(`Could not read file: ${filePath}`);
      return null;
    }
  }

  /**
   * Check if a path matches any exclude pattern
   */
  shouldExclude(filePath) {
    const relativePath = path.relative(this.rootDir, filePath);
    return this.config.excludePatterns.some((pattern) => {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(relativePath);
      }
      return relativePath.includes(pattern);
    });
  }

  /**
   * Recursively get source files from a directory
   */
  getSourceFiles(dir, excludeTest = false) {
    const files = [];
    const fullDir = path.isAbsolute(dir) ? dir : path.join(this.rootDir, dir);

    if (!fs.existsSync(fullDir)) {
      return files;
    }

    const entries = fs.readdirSync(fullDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(fullDir, entry.name);

      if (this.shouldExclude(fullPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...this.getSourceFiles(fullPath, excludeTest));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs'].includes(ext)) {
          if (excludeTest) {
            const isTestFile =
              /\.(test|spec)\.[jt]sx?$/.test(entry.name) ||
              entry.name.includes('__test__') ||
              entry.name.includes('__spec__');
            if (!isTestFile) {
              files.push(fullPath);
            }
          } else {
            files.push(fullPath);
          }
        }
      }
    }

    return files;
  }

  /**
   * Check for console.log statements in production code
   */
  checkConsoleStatements() {
    this.printHeader('Checking for console statements in production code');

    let found = 0;
    const issues = [];

    for (const sourceDir of this.config.sourceDirs) {
      const files = this.getSourceFiles(sourceDir, true);

      for (const file of files) {
        const fileName = path.basename(file).toLowerCase();

        // Skip allowed files
        if (
          this.config.allowedConsoleFiles.some((allowed) =>
            fileName.includes(allowed.toLowerCase())
          )
        ) {
          this.logVerbose(
            `Skipping allowed file: ${path.relative(this.rootDir, file)}`
          );
          continue;
        }

        const content = this.readFileWithCache(file);
        if (!content) continue;

        const lines = content.split('\n');
        lines.forEach((line, index) => {
          // Skip comments
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*')) {
            return;
          }

          // Check for console statements
          const consoleMatch = line.match(
            /console\.(log|debug|info|warn|error|trace|dir|table)\s*\(/
          );
          if (consoleMatch) {
            found++;
            issues.push({
              file: path.relative(this.rootDir, file),
              line: index + 1,
              type: consoleMatch[1],
              content: trimmedLine.substring(0, 80),
            });
          }
        });
      }
    }

    if (found === 0) {
      this.log('No console statements found in production code', 'success');
    } else {
      this.log(`Found ${found} console statement(s):`, 'warning');
      issues.slice(0, 10).forEach((issue) => {
        this.log(
          `${colors.dim}${issue.file}:${issue.line}${colors.reset} - console.${issue.type}()`,
          'bullet'
        );
      });
      if (issues.length > 10) {
        this.log(`... and ${issues.length - 10} more`, 'bullet');
      }
      this.warnings.push(
        `Found ${found} console statement(s) in production code. Consider using a proper logger.`
      );
    }
  }

  /**
   * Check for potential API key leaks
   */
  checkApiKeyLeaks() {
    this.printHeader('Checking for potential API key leaks');

    // First, try to delegate to security-check.cjs if it exists
    const securityCheckPath = path.join(
      this.rootDir,
      'scripts',
      'security-check.cjs'
    );
    if (fs.existsSync(securityCheckPath)) {
      this.log('Delegating to security-check.cjs...', 'info');
      try {
        execSync(`node "${securityCheckPath}"`, {
          stdio: 'inherit',
          timeout: 300000,
        });
        this.log('Security check passed', 'success');
      } catch (error) {
        this.log('Security check failed', 'error');
        this.errors.push('Security check script failed');
      }
      return;
    }

    // Otherwise, perform basic checks
    let found = 0;
    const issues = [];

    for (const sourceDir of this.config.sourceDirs) {
      const files = this.getSourceFiles(sourceDir);

      for (const file of files) {
        const content = this.readFileWithCache(file);
        if (!content) continue;

        const lines = content.split('\n');
        lines.forEach((line, index) => {
          for (const pattern of this.config.secretPatterns) {
            // Reset regex state
            pattern.lastIndex = 0;
            if (pattern.test(line)) {
              // Check if it's likely a false positive (template variable, env reference)
              if (
                line.includes('process.env') ||
                line.includes('${') ||
                line.includes('getenv') ||
                line.includes('config.') ||
                line.match(/['"]?\$\{?[A-Z_]+\}?['"]?/)
              ) {
                continue;
              }

              found++;
              issues.push({
                file: path.relative(this.rootDir, file),
                line: index + 1,
              });
            }
          }
        });
      }
    }

    if (found === 0) {
      this.log('No potential API key leaks detected', 'success');
    } else {
      this.log(`Found ${found} potential secret(s):`, 'error');
      issues.slice(0, 5).forEach((issue) => {
        this.log(
          `${colors.dim}${issue.file}:${issue.line}${colors.reset}`,
          'bullet'
        );
      });
      if (issues.length > 5) {
        this.log(`... and ${issues.length - 5} more`, 'bullet');
      }
      this.errors.push(
        `Found ${found} potential API key leak(s). Review these files carefully.`
      );
    }
  }

  /**
   * Validate package.json configuration
   */
  validatePackageJson() {
    this.printHeader('Validating package.json');

    const packagePath = path.join(this.rootDir, 'package.json');
    if (!fs.existsSync(packagePath)) {
      this.errors.push('package.json not found');
      this.log('package.json not found', 'error');
      return;
    }

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    } catch (error) {
      this.errors.push('Failed to parse package.json');
      this.log('Failed to parse package.json', 'error');
      return;
    }

    const missingScripts = [];
    const scripts = pkg.scripts || {};

    for (const script of this.config.requiredScripts) {
      if (!scripts[script]) {
        missingScripts.push(script);
      }
    }

    if (missingScripts.length === 0) {
      this.log('All required scripts present', 'success');
    } else {
      this.log(`Missing scripts: ${missingScripts.join(', ')}`, 'warning');
      this.warnings.push(
        `Missing recommended scripts: ${missingScripts.join(', ')}`
      );
    }

    // Check for common issues
    if (!pkg.name) {
      this.warnings.push('package.json is missing "name" field');
      this.log('Missing "name" field', 'warning');
    }

    if (!pkg.version) {
      this.warnings.push('package.json is missing "version" field');
      this.log('Missing "version" field', 'warning');
    }

    if (!pkg.engines) {
      this.log(
        'Consider adding "engines" field to specify Node.js version',
        'info'
      );
    }

    // Check for private vs publishConfig
    if (!pkg.private && !pkg.publishConfig) {
      this.log(
        'Package is public. Consider adding "private: true" or "publishConfig"',
        'info'
      );
    }
  }

  /**
   * Check for poor error handling patterns
   */
  checkErrorHandling() {
    this.printHeader('Checking error handling patterns');

    let emptyCatches = 0;
    let unhandledPromises = 0;
    const issues = [];

    for (const sourceDir of this.config.sourceDirs) {
      const files = this.getSourceFiles(sourceDir);

      for (const file of files) {
        const content = this.readFileWithCache(file);
        if (!content) continue;

        const lines = content.split('\n');

        // Check for empty catch blocks
        const emptyCatchPattern = /catch\s*\([^)]*\)\s*\{\s*\}/g;
        let match;
        while ((match = emptyCatchPattern.exec(content)) !== null) {
          emptyCatches++;
          const lineNumber = content
            .substring(0, match.index)
            .split('\n').length;
          issues.push({
            file: path.relative(this.rootDir, file),
            line: lineNumber,
            type: 'empty-catch',
          });
        }

        // Check for .then() without .catch()
        lines.forEach((line, index) => {
          if (line.includes('.then(') && !line.includes('.catch(')) {
            // Look ahead a few lines for .catch
            const nextLines = lines.slice(index, index + 5).join('\n');
            if (!nextLines.includes('.catch(') && !nextLines.includes('try')) {
              unhandledPromises++;
              issues.push({
                file: path.relative(this.rootDir, file),
                line: index + 1,
                type: 'unhandled-promise',
              });
            }
          }
        });
      }
    }

    if (emptyCatches === 0 && unhandledPromises === 0) {
      this.log('No error handling issues found', 'success');
    } else {
      if (emptyCatches > 0) {
        this.log(`Found ${emptyCatches} empty catch block(s)`, 'warning');
        this.warnings.push(
          `Found ${emptyCatches} empty catch block(s). Consider logging or handling errors.`
        );
      }
      if (unhandledPromises > 0) {
        this.log(
          `Found ${unhandledPromises} potentially unhandled Promise(s)`,
          'warning'
        );
        this.warnings.push(
          `Found ${unhandledPromises} potentially unhandled Promise(s). Add .catch() handlers.`
        );
      }

      issues.slice(0, 5).forEach((issue) => {
        const typeLabel =
          issue.type === 'empty-catch' ? 'empty catch' : 'unhandled promise';
        this.log(
          `${colors.dim}${issue.file}:${issue.line}${colors.reset} - ${typeLabel}`,
          'bullet'
        );
      });
    }
  }

  /**
   * Check for TODO/FIXME comments without issue references
   */
  checkTodoReferences() {
    this.printHeader('Checking TODO/FIXME references');

    let unreferencedTodos = 0;
    const issues = [];

    // Pattern for issue references (GitHub, Jira, etc.)
    const issueRefPattern = /#\d+|[A-Z]+-\d+|https?:\/\/\S+/;

    for (const sourceDir of this.config.sourceDirs) {
      const files = this.getSourceFiles(sourceDir);

      for (const file of files) {
        const content = this.readFileWithCache(file);
        if (!content) continue;

        const lines = content.split('\n');
        lines.forEach((line, index) => {
          const todoMatch = line.match(
            /(?:\/\/|\/\*|#|\*)\s*(TODO|FIXME|XXX|HACK|BUG)[\s:]/i
          );
          if (todoMatch) {
            if (!issueRefPattern.test(line)) {
              unreferencedTodos++;
              issues.push({
                file: path.relative(this.rootDir, file),
                line: index + 1,
                type: todoMatch[1].toUpperCase(),
                content: line.trim().substring(0, 60),
              });
            }
          }
        });
      }
    }

    if (unreferencedTodos === 0) {
      this.log('All TODO/FIXME comments have issue references', 'success');
    } else {
      this.log(
        `Found ${unreferencedTodos} TODO/FIXME without issue reference:`,
        'warning'
      );
      issues.slice(0, 5).forEach((issue) => {
        this.log(
          `${colors.dim}${issue.file}:${issue.line}${colors.reset} - ${issue.type}`,
          'bullet'
        );
      });
      if (issues.length > 5) {
        this.log(`... and ${issues.length - 5} more`, 'bullet');
      }
      this.warnings.push(
        `Found ${unreferencedTodos} TODO/FIXME comment(s) without issue references. Link to tracking issues.`
      );
    }
  }

  /**
   * Check environment configuration
   */
  checkEnvironmentConfig() {
    this.printHeader('Checking environment configuration');

    const envExamplePath = path.join(this.rootDir, '.env.example');
    const envPath = path.join(this.rootDir, '.env');

    if (!fs.existsSync(envExamplePath)) {
      this.log('.env.example not found', 'warning');
      this.warnings.push(
        'No .env.example file found. Create one to document required environment variables.'
      );
      return;
    }

    this.log('.env.example exists', 'success');

    // Parse .env.example
    const exampleContent = fs.readFileSync(envExamplePath, 'utf-8');
    const exampleVars = new Set();
    exampleContent.split('\n').forEach((line) => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
      if (match) {
        exampleVars.add(match[1]);
      }
    });

    if (exampleVars.size === 0) {
      this.log('.env.example appears to be empty', 'warning');
      return;
    }

    this.log(`Documented ${exampleVars.size} environment variable(s)`, 'info');

    // If .env exists, check for completeness
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const envVars = new Set();
      envContent.split('\n').forEach((line) => {
        const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
        if (match) {
          envVars.add(match[1]);
        }
      });

      const missingVars = [...exampleVars].filter((v) => !envVars.has(v));
      if (missingVars.length > 0) {
        this.log(`Missing in .env: ${missingVars.join(', ')}`, 'warning');
        this.warnings.push(`Your .env is missing: ${missingVars.join(', ')}`);
      } else {
        this.log('All documented variables present in .env', 'success');
      }
    }

    // Check if .env is in .gitignore
    const gitignorePath = path.join(this.rootDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
      if (!gitignore.includes('.env')) {
        this.log(
          '.env should be in .gitignore to prevent secret leaks',
          'warning'
        );
        this.warnings.push(
          'Add .env to .gitignore to prevent committing secrets'
        );
      }
    }
  }

  /**
   * Check project structure
   */
  checkProjectStructure() {
    this.printHeader('Checking project structure');

    let hasIssues = false;

    // Check required directories
    for (const dir of this.config.requiredDirs) {
      const dirPath = path.join(this.rootDir, dir);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        this.log(`Directory exists: ${dir}/`, 'success');
      } else {
        this.log(`Missing directory: ${dir}/`, 'error');
        this.errors.push(`Required directory missing: ${dir}/`);
        hasIssues = true;
      }
    }

    // Check required files
    for (const file of this.config.requiredFiles) {
      const filePath = path.join(this.rootDir, file);
      if (fs.existsSync(filePath)) {
        this.log(`File exists: ${file}`, 'success');
      } else {
        this.log(`Missing file: ${file}`, 'error');
        this.errors.push(`Required file missing: ${file}`);
        hasIssues = true;
      }
    }

    // Check for common project files (non-critical)
    const recommendedFiles = [
      { file: 'README.md', message: 'Consider adding a README.md' },
      { file: '.gitignore', message: 'Consider adding a .gitignore' },
      {
        file: '.editorconfig',
        message: 'Consider adding .editorconfig for consistent formatting',
      },
    ];

    for (const { file, message } of recommendedFiles) {
      const filePath = path.join(this.rootDir, file);
      if (!fs.existsSync(filePath)) {
        this.logVerbose(message);
      }
    }

    if (!hasIssues) {
      this.log('Project structure looks good', 'success');
    }
  }

  /**
   * Print the validation summary
   */
  printSummary() {
    console.log();
    console.log(`${colors.bold}${'═'.repeat(60)}${colors.reset}`);
    console.log(`${colors.bold}  Build Validation Summary${colors.reset}`);
    console.log(`${'═'.repeat(60)}`);
    console.log();

    if (this.errors.length === 0 && this.warnings.length === 0) {
      console.log(
        `  ${symbols.success} ${colors.green}${colors.bold}All validations passed!${colors.reset}`
      );
      console.log();
      return true;
    }

    if (this.errors.length > 0) {
      console.log(
        `  ${colors.red}${colors.bold}Errors (${this.errors.length}):${colors.reset}`
      );
      this.errors.forEach((error) => {
        console.log(`    ${symbols.error} ${error}`);
      });
      console.log();
    }

    if (this.warnings.length > 0) {
      console.log(
        `  ${colors.yellow}${colors.bold}Warnings (${this.warnings.length}):${colors.reset}`
      );
      this.warnings.forEach((warning) => {
        console.log(`    ${symbols.warning} ${warning}`);
      });
      console.log();
    }

    if (this.errors.length > 0) {
      console.log(
        `  ${colors.red}Build validation failed with ${this.errors.length} error(s).${colors.reset}`
      );
      console.log(
        `  ${colors.dim}Fix the errors above before proceeding.${colors.reset}`
      );
      return false;
    }

    if (this.strict && this.warnings.length > 0) {
      console.log(
        `  ${colors.yellow}Build validation failed (strict mode) with ${this.warnings.length} warning(s).${colors.reset}`
      );
      console.log(
        `  ${colors.dim}Set BUILD_VALIDATION_STRICT=false to allow warnings.${colors.reset}`
      );
      return false;
    }

    console.log(
      `  ${colors.green}Build validation passed with ${this.warnings.length} warning(s).${colors.reset}`
    );
    return true;
  }

  /**
   * Run all validation checks
   */
  run() {
    console.log();
    console.log(
      `${colors.bold}${colors.cyan}╔${'═'.repeat(58)}╗${colors.reset}`
    );
    console.log(
      `${colors.bold}${colors.cyan}║${colors.reset}  ${colors.bold}Build Validation${colors.reset}${' '.repeat(40)}${colors.bold}${colors.cyan}║${colors.reset}`
    );
    console.log(
      `${colors.bold}${colors.cyan}║${colors.reset}  ${colors.dim}Pre-build checks for code quality${colors.reset}${' '.repeat(22)}${colors.bold}${colors.cyan}║${colors.reset}`
    );
    console.log(
      `${colors.bold}${colors.cyan}╚${'═'.repeat(58)}╝${colors.reset}`
    );

    try {
      this.checkProjectStructure();
      this.validatePackageJson();
      this.checkEnvironmentConfig();
      this.checkConsoleStatements();
      this.checkApiKeyLeaks();
      this.checkErrorHandling();
      this.checkTodoReferences();
    } catch (error) {
      console.error(
        `\n${symbols.error} Validation script error: ${error.message}`
      );
      if (this.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }

    const passed = this.printSummary();
    console.log();

    process.exit(passed ? 0 : 1);
  }
}

// Run validation if executed directly
if (require.main === module) {
  const validator = new BuildValidator();
  validator.run();
}

module.exports = { BuildValidator };
