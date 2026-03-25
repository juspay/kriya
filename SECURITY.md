# Security Policy

## Supported Versions

The following versions of @juspay/kriya are currently supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| X.x.x   | :white_check_mark: |
| X.x.x   | :white_check_mark: |
| < X.x   | :x:                |

## Reporting a Vulnerability

We take the security of @juspay/kriya seriously. If you discover a security vulnerability, please follow these guidelines:

### DO NOT Create Public Issues

**Please DO NOT report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

### How to Report

Please report security vulnerabilities by emailing us at:

**opensource@juspay.in**

### What to Include in Your Report

To help us triage and respond to your report quickly, please include:

- **Description**: A clear description of the vulnerability
- **Impact**: The potential impact of the vulnerability
- **Steps to Reproduce**: Detailed steps to reproduce the issue
- **Affected Versions**: Which versions are affected
- **Proof of Concept**: Any code or screenshots demonstrating the vulnerability (if applicable)
- **Suggested Fix**: If you have suggestions for how to fix the vulnerability (optional)

## Response Timeline

We are committed to responding to security reports promptly:

| Action                 | Timeline                      |
| ---------------------- | ----------------------------- |
| Initial Acknowledgment | Within 24 hours               |
| Initial Assessment     | Within 72 hours               |
| Status Update          | Every 5-7 days until resolved |

### Fix Timeline by Severity

| Severity | Target Resolution Time |
| -------- | ---------------------- |
| Critical | 24-48 hours            |
| High     | 7 days                 |
| Medium   | 30 days                |
| Low      | 90 days                |

_Note: These timelines are targets. Actual resolution time may vary based on complexity._

## Security Best Practices

When using @juspay/kriya, we recommend following these security best practices:

### API Key Management

- Never commit API keys or secrets to version control
- Use environment variables or secure secret management solutions
- Rotate API keys regularly
- Use the minimum required permissions for API keys

### Environment Variables

- Store sensitive configuration in environment variables
- Use `.env` files only for local development
- Add `.env` to your `.gitignore` file
- Use different credentials for development and production

### Dependencies

- Keep all dependencies up to date
- Regularly run `npm audit` or equivalent to check for vulnerabilities
- Review dependency changes before updating
- Consider using a dependency scanning tool in your CI/CD pipeline

## Security Updates

### How to Subscribe

Stay informed about security updates:

- **Watch Releases**: Watch the repository for release notifications
- **GitHub Security Advisories**: Enable security alerts for the repository
- **Release Notes**: Review release notes for security-related changes

### GitHub Security Advisories

Security advisories for @juspay/kriya are published at:

https://github.com/juspay/kriya/security/advisories

You can also view known vulnerabilities at:

https://github.com/juspay/kriya/security

## Bug Bounty Program

At this time, @juspay/kriya does not offer a paid bug bounty program. However, we deeply appreciate the efforts of security researchers and will:

- Acknowledge your contribution in our security advisories (with your permission)
- Provide credit in release notes for responsibly disclosed vulnerabilities
- Consider adding you to our security hall of fame

If you are interested in participating in security research for @juspay/kriya, please reach out to us at opensource@juspay.in.

## Contact

For any security-related questions or concerns, please contact:

**Email**: opensource@juspay.in

For non-security related issues, please use the standard GitHub issue tracker.

## Attribution

We would like to thank all security researchers and community members who help keep @juspay/kriya and its users safe.

This security policy is inspired by industry best practices and the collaborative efforts of the open source security community.

---

_This security policy was last updated on the date of the latest commit to this file._
