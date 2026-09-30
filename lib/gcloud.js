import { exec, execFile } from 'node:child_process'

export class UserError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

// Runs a gcloud command and returns its parsed JSON output (or trimmed text when format is null).
export function gcloud(args, { format = 'json' } = {}) {
  const fullArgs = format ? [...args, `--format=${format}`] : args
  console.log(`> gcloud ${fullArgs.join(' ')}`)

  const options = {
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
  }

  return new Promise((resolve, reject) => {
    const callback = (error, stdout, stderr) => {
      if (error) return reject(toUserError(error, stderr))
      resolve(format === 'json' ? JSON.parse(stdout || 'null') : stdout.trim())
    }

    // gcloud is a .cmd script on Windows, which Node can only run through cmd.exe
    if (process.platform === 'win32') {
      exec(['gcloud', ...fullArgs].map(quoteForCmd).join(' '), options, callback)
    } else {
      execFile('gcloud', fullArgs, options, callback)
    }
  })
}

function quoteForCmd(arg) {
  if (/["%\r\n]/.test(arg)) throw new Error(`Unsafe gcloud argument: ${arg}`)
  return /[\s&|<>^(),;=]/.test(arg) ? `"${arg}"` : arg
}

function toUserError(error, stderr = '') {
  if (error.code === 'ENOENT' || /is not recognized as an internal or external command/.test(stderr)) {
    return new UserError('gcloud isn’t installed. Close this app and run the start script again to install it.')
  }

  if (/compute\.googleapis\.com/.test(stderr) && /not enabled|SERVICE_DISABLED|has not been used|is disabled/i.test(stderr)) {
    return new UserError('Compute Engine isn’t enabled for this project yet.', 'COMPUTE_DISABLED')
  }

  // gcloud errors look like "ERROR: (gcloud.compute.instances.create) <message>"
  const start = stderr.indexOf('ERROR:')
  const message = (start === -1 ? stderr : stderr.slice(start)).replace(/^ERROR:\s*(\([^)]*\)\s*)?/, '').trim()
  return new UserError(message || error.message)
}
