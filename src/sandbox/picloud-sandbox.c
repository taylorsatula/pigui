// picloud-sandbox: run one program confined by Landlock to the paths it is given. picloud starts every agent command
// through it, so a command can reach its session's workspace, home and tmp, and read the system, and nothing else.
//
//   picloud-sandbox [--ro PATH]... [--rw PATH]... -- PROGRAM [ARGS]...
//   picloud-sandbox --abi
//
// --ro grants reading and executing below PATH, --rw grants every right. Paths that do not exist are skipped, so a
// policy can name directories some machines lack (/lib32, a skills directory not created yet), and so are paths this
// user cannot open, which stay out of reach either way. Every filesystem right the running kernel knows is handled, as
// the kernel's samples/landlock/sandboxer.c does, so a newer kernel restricts more without a rebuild. From ABI 6,
// signals and abstract unix sockets are scoped to the command's own processes. TCP is left alone. --abi prints the
// kernel's Landlock ABI, for picloud's startup check.
//
// Exit codes follow env(1): 125 when the sandbox cannot be set up, 126 when PROGRAM cannot run, 127 when it is not
// found. Otherwise the exit code is PROGRAM's.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

// Rights and scopes newer than the headers of older distributions (Ubuntu 24.04 ships ABI 4 headers).
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#endif
#ifndef LANDLOCK_SCOPE_SIGNAL
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif

// The ruleset attribute as of ABI 6. Older headers lack `scoped`; older kernels accept the longer struct as long as
// the fields they do not know are zero, which the ABI checks below ensure.
struct ruleset_attr {
	__u64 handled_access_fs;
	__u64 handled_access_net;
	__u64 scoped;
};

#define ACCESS_FS_V1                                                                                                   \
	(LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE |                       \
	 LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |                    \
	 LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |                        \
	 LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |                     \
	 LANDLOCK_ACCESS_FS_MAKE_SYM)

#define ACCESS_READ (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)

// The rights a rule on a file (not a directory) may carry; the kernel rejects a file rule with any other.
#define ACCESS_FILE                                                                                                    \
	(LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE |                       \
	 LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV)

static const char USAGE[] = "usage: picloud-sandbox [--ro PATH]... [--rw PATH]... -- PROGRAM [ARGS]...\n"
			    "       picloud-sandbox --abi\n";

static int landlock_abi(void) {
	return (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
}

static void unavailable(void) {
	fprintf(stderr,
		"picloud-sandbox: Landlock is not available (%s). It needs Linux 5.13 or later with Landlock enabled; "
		"Debian 13's kernel has it.\n",
		strerror(errno));
}

// Allow `access` below `path`, or on `path` alone when it is a file. 0 also when the path does not exist, or this user
// cannot reach it, which leaves it as out of reach as a rule would have made it reachable.
static int allow(int ruleset, const char *path, __u64 access) {
	int fd = open(path, O_PATH | O_CLOEXEC);
	if (fd < 0) {
		if (errno == ENOENT || errno == ENOTDIR || errno == EACCES) return 0;
		fprintf(stderr, "picloud-sandbox: cannot open %s: %s\n", path, strerror(errno));
		return -1;
	}
	struct stat info;
	if (fstat(fd, &info) != 0) {
		fprintf(stderr, "picloud-sandbox: cannot stat %s: %s\n", path, strerror(errno));
		close(fd);
		return -1;
	}
	if (!S_ISDIR(info.st_mode)) access &= ACCESS_FILE;
	struct landlock_path_beneath_attr rule = {.allowed_access = access, .parent_fd = fd};
	int result = (int)syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
	if (result != 0) fprintf(stderr, "picloud-sandbox: cannot allow %s: %s\n", path, strerror(errno));
	close(fd);
	return result;
}

int main(int argc, char *argv[]) {
	if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
		int abi = landlock_abi();
		if (abi < 0) {
			unavailable();
			return 125;
		}
		printf("%d\n", abi);
		return 0;
	}

	int program = 0;
	for (int index = 1; index < argc; index++) {
		if (strcmp(argv[index], "--") == 0) {
			program = index + 1;
			break;
		}
		if ((strcmp(argv[index], "--ro") != 0 && strcmp(argv[index], "--rw") != 0) || index + 1 >= argc) {
			fputs(USAGE, stderr);
			return 125;
		}
		index++;
	}
	if (program == 0 || program >= argc) {
		fputs(USAGE, stderr);
		return 125;
	}

	int abi = landlock_abi();
	if (abi < 0) {
		unavailable();
		return 125;
	}
	struct ruleset_attr attr = {
		.handled_access_fs = ACCESS_FS_V1 | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE |
				     LANDLOCK_ACCESS_FS_IOCTL_DEV,
		.handled_access_net = 0,
		.scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL,
	};
	// Drop what the running kernel does not know, newest first, so an older kernel still gets what it can enforce.
	if (abi < 2) attr.handled_access_fs &= ~LANDLOCK_ACCESS_FS_REFER;
	if (abi < 3) attr.handled_access_fs &= ~LANDLOCK_ACCESS_FS_TRUNCATE;
	if (abi < 5) attr.handled_access_fs &= ~LANDLOCK_ACCESS_FS_IOCTL_DEV;
	if (abi < 6) attr.scoped = 0;

	int ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof(attr), 0);
	if (ruleset < 0) {
		fprintf(stderr, "picloud-sandbox: cannot create a Landlock ruleset: %s\n", strerror(errno));
		return 125;
	}
	for (int index = 1; index < program - 1; index += 2) {
		__u64 access = strcmp(argv[index], "--rw") == 0 ? attr.handled_access_fs : ACCESS_READ;
		if (allow(ruleset, argv[index + 1], access) != 0) return 125;
	}
	// Without no_new_privs an unprivileged process may not restrict itself, and a setuid program could escape.
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
		fprintf(stderr, "picloud-sandbox: cannot set no_new_privs: %s\n", strerror(errno));
		return 125;
	}
	if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0) {
		fprintf(stderr, "picloud-sandbox: cannot restrict itself: %s\n", strerror(errno));
		return 125;
	}
	close(ruleset);

	execvp(argv[program], &argv[program]);
	fprintf(stderr, "picloud-sandbox: %s: %s\n", argv[program], strerror(errno));
	return errno == ENOENT ? 127 : 126;
}
