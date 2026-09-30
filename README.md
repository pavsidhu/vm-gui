# VM GUI

A small local web app for Windows desktops on Google Cloud. Pick a project, then create, start, stop, delete, and connect to VMs over Remote Desktop, with keyboard, mouse and clipboard working as normal.

Each desktop is an **e2-standard-2 (2 vCPU, 8 GB) Windows Server 2025 VM in London** with Chrome installed.

## Install and run

**Mac:** open Terminal and run:

```sh
curl -fsSL https://raw.githubusercontent.com/pavsidhu/vm-gui/main/install.sh | bash
```

**Windows:** open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/pavsidhu/vm-gui/main/install.ps1 | iex
```

This downloads VM GUI into a `vm-gui` folder in your home folder. The first time, it also installs anything that's missing (you may be asked for your password), then asks you to sign in to Google Cloud in your browser:

| | Mac | Windows |
|---|---|---|
| Node.js | ✓ | ✓ |
| Google Cloud CLI | ✓ (plus Python, if needed) | ✓ |
| Remote Desktop app | Windows App | Built in |

Then it opens the app at http://localhost:4870. Keep the Terminal or PowerShell window open while you use it. Closing it quits the app.

Run the same command whenever you want to use VM GUI; it also updates to the latest version. You can also double-click `start-mac.command` or `start-windows.bat` in the `vm-gui` folder.

## Connecting

Click **Connect** on a running desktop. The app:

1. Opens the VM's Remote Desktop port to your current public IP (a firewall rule per IP, named `cloud-desktops-rdp-…`).
2. Opens Remote Desktop pointed at the VM.
   - **Windows:** signs in automatically.
   - **Mac:** puts the password on your clipboard. Paste it when Windows App asks.

A brand-new desktop takes about 5 minutes to finish setting up before you can connect. The first time you connect, Remote Desktop warns about the VM's certificate; accept it to continue.

Everyone connecting to a desktop signs in as the same Windows user. If someone else connects, they take over the session (and the browser windows in it).

## New projects

Click **New project** next to the project picker and give it a name. The app then:

1. Creates the Google Cloud project, with an ID like `alex-desktops-3f9a1c`.
2. Links it to your billing account. If you have more than one, you pick which.
3. Turns on Compute Engine.

This takes a minute or two. Google limits how many projects an account can create, and how many projects a billing account can be linked to. If you hit either limit, the app shows Google's error message.

## Sharing with other people

Other people install VM GUI on their own computer and sign in with their own Google account. They can then either:

- **Use one of your projects.** Give their Google account access, and the project shows up in their project picker:

  ```sh
  gcloud projects add-iam-policy-binding PROJECT_ID --member=user:friend@example.com --role=roles/compute.admin
  ```

- **Use their own project** by clicking **New project**. This needs a billing account on their Google account.

## Costs

Rough figures for London (check the [pricing calculator](https://cloud.google.com/products/calculator) for exact ones):

- **Running:** the e2-standard-2 VM plus a Windows Server licence, roughly $0.15–0.20 per hour.
- **Stopped:** you only pay for the 50 GB disk, roughly $6 per month.
- **Deleted:** nothing.

## How it works

- `server.js` is a zero-dependency Node server that only listens on localhost. Every action runs a `gcloud` command (logged in the terminal).
- Only VMs created by this app (labelled `app=cloud-desktops`) are listed.
- The Remote Desktop login is stored in the VM's metadata. `lib/windows-startup.ps1` runs on every boot and:
  - creates that Windows user;
  - installs Chrome;
  - sets UK time;
  - reports back when the desktop is ready.

  Anyone with access to the project can see the login.
