#!/usr/bin/env bash

# @juspay/kriya - Pre-commit Validation Script
# This script runs comprehensive validation before commits
# Created by Shelly - Repository Organization Tool

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE} $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Track failures
VALIDATION_FAILED=0

# Function to run a validation step
run_validation() {
    local step_name=$1
    local step_command=$2

    print_info "Running: $step_name"

    if eval "$step_command"; then
        print_success "$step_name passed"
        return 0
    else
        print_error "$step_name failed"
        VALIDATION_FAILED=1
        return 1
    fi
}

# Main validation pipeline
print_header "PRE-COMMIT VALIDATION - @juspay/kriya"

# 1. Code Linting
print_header "1. Code Linting (ESLint)"
if command -v eslint &> /dev/null; then
    # Note: || true allows script to continue and collect all failures
    # Final validation status is checked at the end via VALIDATION_FAILED flag
    run_validation "ESLint check" "npm run lint -- --max-warnings=0" || true
else
    print_warning "ESLint not found, skipping linting"
fi

# 2. Code Formatting
print_header "2. Code Formatting (Prettier)"
if command -v prettier &> /dev/null; then
    run_validation "Prettier check" "npm run format:check" || true
else
    print_warning "Prettier not found, skipping format check"
fi

# 3. TypeScript Compilation (Build Validation)
print_header "3. TypeScript Compilation Check"
if [ -f "tsconfig.json" ]; then
    if command -v tsc &> /dev/null; then
        run_validation "TypeScript compilation" "tsc --noEmit" || true
    else
        print_warning "TypeScript compiler not found, skipping build validation"
    fi
else
    print_info "No tsconfig.json found, skipping TypeScript check"
fi

# 4. Secret Scanning
print_header "4. Secret Scanning (Gitleaks)"
if command -v gitleaks &> /dev/null; then
    if [ -f ".gitleaksrc.json" ]; then
        run_validation "Gitleaks scan" "gitleaks protect --staged --config .gitleaksrc.json --verbose" || true
    else
        run_validation "Gitleaks scan" "gitleaks protect --staged --verbose" || true
    fi
else
    print_warning "Gitleaks not installed, skipping secret scanning"
    print_info "Install: brew install gitleaks (macOS) or see https://github.com/gitleaks/gitleaks"
fi

# 5. Environment File Validation
print_header "5. Environment File Validation"
if [ -f ".env.example" ]; then
    print_info "Checking .env.example exists"

    # Check if .env exists and has all required keys from .env.example
    if [ -f ".env" ]; then
        print_info "Validating .env has all required keys from .env.example"

        # Extract keys from .env.example (ignore comments and empty lines)
        EXAMPLE_KEYS=$(grep -v '^#' .env.example | grep -v '^$' | cut -d '=' -f 1 | sort)

        # Extract keys from .env
        ENV_KEYS=$(grep -v '^#' .env | grep -v '^$' | cut -d '=' -f 1 | sort)

        # Find missing keys
        MISSING_KEYS=$(comm -23 <(echo "$EXAMPLE_KEYS") <(echo "$ENV_KEYS"))

        if [ -n "$MISSING_KEYS" ]; then
            print_warning "Missing keys in .env file:"
            echo "$MISSING_KEYS"
        else
            print_success "All required environment variables present"
        fi
    else
        print_warning ".env file not found (optional for local development)"
    fi
else
    print_info "No .env.example found, skipping environment validation"
fi

# 6. Check for debugging statements
print_header "6. Debugging Statement Check"
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|ts|jsx|tsx)$' || true)

if [ -n "$STAGED_FILES" ]; then
    print_info "Checking for debugging statements in staged files"

    # Check for console.log, debugger, etc.
    DEBUG_PATTERN="console\.(log|debug|warn|error)|debugger"
    DEBUG_FOUND=0

    while IFS= read -r file; do
        if [ -f "$file" ]; then
            if grep -nE "$DEBUG_PATTERN" "$file" > /dev/null 2>&1; then
                if [ $DEBUG_FOUND -eq 0 ]; then
                    print_warning "Debugging statements found in:"
                    DEBUG_FOUND=1
                fi
                echo "  - $file"
            fi
        fi
    done <<< "$STAGED_FILES"

    if [ $DEBUG_FOUND -eq 0 ]; then
        print_success "No debugging statements found"
    else
        print_warning "Consider removing debugging statements before committing"
        # Note: This is a warning, not a failure
    fi
else
    print_info "No JavaScript/TypeScript files staged"
fi

# 7. Check for large files
print_header "7. Large File Check"
LARGE_FILES=$(git diff --cached --name-only --diff-filter=ACM | while read file; do
    if [ -f "$file" ]; then
        SIZE=$(wc -c < "$file")
        # Warn about files larger than 1MB
        if [ $SIZE -gt 1048576 ]; then
            # Cross-platform file size formatting (numfmt not available on macOS)
            if command -v numfmt &> /dev/null; then
                SIZE_HR=$(numfmt --to=iec-i --suffix=B $SIZE)
            else
                # Fallback for macOS and systems without numfmt
                if [ $SIZE -ge 1073741824 ]; then
                    SIZE_GB=$((SIZE / 1073741824))
                    SIZE_HR="${SIZE_GB}GB"
                elif [ $SIZE -ge 1048576 ]; then
                    SIZE_MB=$((SIZE / 1048576))
                    SIZE_HR="${SIZE_MB}MB"
                else
                    SIZE_KB=$((SIZE / 1024))
                    SIZE_HR="${SIZE_KB}KB"
                fi
            fi
            echo "$file ($SIZE_HR)"
        fi
    fi
done)

if [ -n "$LARGE_FILES" ]; then
    print_warning "Large files detected (>1MB):"
    echo "$LARGE_FILES"
    print_warning "Consider using Git LFS for large binary files"
else
    print_success "No large files detected"
fi

# Summary
print_header "VALIDATION SUMMARY"

# Explicitly check validation status before declaring success or failure
# This ensures accuracy even if individual validations used || true to continue
if [ "$VALIDATION_FAILED" -eq 1 ]; then
    print_error "Pre-commit validation FAILED"
    echo ""
    print_info "Please fix the issues above before committing"
    print_info "You can bypass this check with: git commit --no-verify (not recommended)"
    echo ""
    exit 1
else
    print_success "All pre-commit validations PASSED"
    echo ""
    print_info "Proceeding with commit..."
    echo ""
    exit 0
fi
