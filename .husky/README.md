# Husky Git Hooks

This directory contains Git hooks managed by [Husky](https://typicode.github.io/husky/).

## Available Hooks

### pre-commit

Runs before commits to check code quality:

- Linting with ESLint
- Formatting with Prettier
- Type checking (if TypeScript)

### commit-msg

Validates commit messages using commitlint to ensure they follow conventional commit format.

### pre-push

Runs before pushing to remote:

- Run tests
- Build check

## Installation

Hooks are automatically installed when running:

```bash
npm install
```

## Customization

To modify hooks, edit the files in the `.husky` directory or update the husky configuration in `package.json`.
