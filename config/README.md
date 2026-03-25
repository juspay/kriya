# Configuration

This directory contains configuration files for @juspay/kriya.

## Structure

- `default.json` - Default configuration values
- `development.json` - Development environment overrides
- `production.json` - Production environment overrides
- `test.json` - Test environment overrides

## Usage

Configuration files are loaded based on the `NODE_ENV` environment variable. The config library (like [config](https://www.npmjs.com/package/config) or [dotenv](https://www.npmjs.com/package/dotenv)) will merge configuration files in the following order:

1. default.json
2. {NODE_ENV}.json (development.json, production.json, etc.)
3. Environment variables

## Example

```javascript
import config from 'config';

const apiUrl = config.get('api.url');
const port = config.get('server.port');
```

## Security

⚠️ **Important**: Never commit sensitive data like API keys, passwords, or tokens to this directory. Use environment variables or a secrets management service instead.
