// BNCMAgent: the login agent (~/Library/LaunchAgents, src/agent.mjs). It waits, without polling,
// for NetEase Cloud Music to start, and then runs the command it was given (the BetterNCM
// launcher with `launch --agent`), which decides what to do: an NCM opened without the debug port
// is reopened with it and injected, anything else is left alone. It also runs the command once
// when it starts (at login macOS may already have reopened NCM).
//
//   BNCMAgent <program> [arguments...]
import AppKit

let NCM_BUNDLE_ID = "com.netease.163music"
let command = Array(CommandLine.arguments.dropFirst())
guard !command.isEmpty else {
    FileHandle.standardError.write("usage: BNCMAgent <program> [arguments...]\n".data(using: .utf8)!)
    exit(2)
}

// Children are not waited for: they are reaped as they exit.
signal(SIGCHLD, SIG_IGN)

var lastRun = Date.distantPast

func log(_ s: String) {
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] [agent] \(s)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
}

/// Runs the command in a session of its own, so it is not stopped with this agent (launchd stops
/// the agent's process group when the agent is unloaded) and outlives it as the injector.
func runCommand(_ why: String) {
    // NCM's own relaunch by the injector also arrives here; the command sees the running
    // injector and exits, but there is no need to start it twice for one launch.
    if Date().timeIntervalSince(lastRun) < 1 { return }
    lastRun = Date()
    var attrs: posix_spawnattr_t?
    posix_spawnattr_init(&attrs)
    posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETSID))
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    let argv: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, command[0], &actions, &attrs, argv, environ)
    posix_spawn_file_actions_destroy(&actions)
    posix_spawnattr_destroy(&attrs)
    if rc == 0 { log("\(why): started pid \(pid)") } else { log("\(why): could not start \(command[0]): \(String(cString: strerror(rc)))") }
}

let center = NSWorkspace.shared.notificationCenter
center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { n in
    guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
          app.bundleIdentifier == NCM_BUNDLE_ID else { return }
    runCommand("NCM started (pid \(app.processIdentifier))")
}

// Unloaded (launchctl bootout, an uninstall): stop at once.
signal(SIGTERM) { _ in exit(0) }

if NSRunningApplication.runningApplications(withBundleIdentifier: NCM_BUNDLE_ID).isEmpty {
    log("waiting for NCM")
} else {
    runCommand("NCM is running")
}
RunLoop.main.run()
