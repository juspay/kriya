# 🚀 Yalc Installation Instructions

## ✅ Package Successfully Published to Yalc

The enhanced `@juspay/kriya` package with React Final Form initial values support has been published to yalc and is ready for local testing.

## 📦 Installation in Your Project

### 1. Navigate to Your Dashboard Project
```bash
cd /path/to/your/rescript-euler-dashboard
# or wherever your project is located
```

### 2. Install from Yalc
```bash
yalc add @juspay/kriya
```

### 3. Install Dependencies (if needed)
```bash
npm install
# or yarn install
```

### 4. Verify Installation
Check that the package appears in your `package.json`:
```json
{
  "dependencies": {
    "@juspay/kriya": "file:.yalc/@juspay/kriya"
  }
}
```

## 🧪 Testing the Enhanced Features

### 1. Basic Import and Usage
```typescript
import { createAutomationEngine } from '@juspay/kriya';

const engine = createAutomationEngine({
  debugMode: true, // Enable detailed console logging
  formDetectionEnabled: true
});

engine.initialize();
```

### 2. Test Form Filling with Debug Output
```typescript
// This will show detailed debugging information
await engine.executeAction({
  type: 'fillForm',
  parameters: {
    fields: JSON.stringify({
      // Use actual field names from your forms
      username: 'testuser',
      email: 'test@example.com'
    })
  }
});
```

### 3. Check Console Logs
You should see detailed output like:
```
🔍 Starting fillAnyForm with fields: ["username", "email"]
📊 Currently registered forms: 1
✅ Found React Final Form API, using enhanced API
✨ Using React Final Form initialize() for efficient bulk filling
✅ Successfully initialized 2 fields via initialize()
```

## 🔄 Updating to New Versions

When I make updates to the package:

1. **Re-publish from kriya directory:**
   ```bash
   cd /Users/navipriya.s/kriya
   yalc publish
   ```

2. **Update in your project:**
   ```bash
   cd /path/to/your/dashboard
   yalc update @juspay/kriya
   ```

## 🐛 Debugging Common Issues

### If "No suitable form found" error persists:

1. **Enable debug mode:**
   ```typescript
   const engine = createAutomationEngine({
     debugMode: true
   });
   ```

2. **Check what forms are detected:**
   ```typescript
   const context = await engine.capturePageContext();
   console.log('Available forms:', context.forms);
   ```

3. **Look at console logs** - they'll show:
   - How many forms were found on the page
   - Which ones have React Final Form APIs
   - What field names are available
   - Why field matching failed

### If forms aren't being detected:

1. **Manual re-scan:**
   ```typescript
   engine.dispose();
   engine.initialize();
   ```

2. **Check timing** - forms might load after the initial scan
3. **Verify React Final Form setup** - logs will show if React fiber is detected

## 📋 What's Enhanced in This Version

- ✅ **React Final Form API Detection** - Uses actual `formApi.initialize()` and `formApi.change()`
- ✅ **Initial Values Support** - Efficient bulk filling with `initialize()`
- ✅ **Enhanced Debugging** - Detailed console logs for troubleshooting
- ✅ **Automatic Retry Logic** - Re-scans if no forms initially found
- ✅ **Field Matching Analysis** - Shows exactly why forms aren't matched
- ✅ **Multiple Fallback Strategies** - Works with both React Final Form and native forms

## 🎯 Next Steps

1. Install the package in your dashboard using the commands above
2. Test with your existing forms
3. Check console logs to see the enhanced debugging output
4. Update field names in your fillForm commands based on the debug output

The package is ready for testing with your React Final Form setup!
