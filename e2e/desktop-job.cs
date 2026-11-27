using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DesktopJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTimeLimit, JobTimeLimit;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr security, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr length);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Main(string[] args)
    {
        int number;
        if (args.Length != 2 || !int.TryParse(args[1], out number) || number <= 0) {
            throw new ArgumentException("Expected <Paseo.exe> <debugging port> or --process-path <pid>");
        }
        if (args[0] == "--process-path") {
            using (Process process = Process.GetProcessById(number)) {
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.WriteLine(process.MainModule.FileName);
            }
            return 0;
        }
        if (number > ushort.MaxValue) throw new ArgumentOutOfRangeException("debugging port");

        // Join the job before starting Electron so the kernel owns every descendant.
        IntPtr job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
            !AssignProcessToJobObject(job, GetCurrentProcess())) {
            var error = new Win32Exception();
            CloseHandle(job);
            throw error;
        }

        // The OS closes our noninheritable job handle on exit, including forced termination.
        using (Process app = Process.Start(new ProcessStartInfo(args[0],
            "--no-sandbox --remote-debugging-port=" + number) { UseShellExecute = false })) {
            if (app == null) throw new InvalidOperationException("Could not start Paseo");
            Console.WriteLine("Started Paseo " + app.Id + " in the Desktop E2E job");
            Accounting accounting;
            do {
                if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                    throw new Win32Exception();
                if (accounting.ActiveProcesses > 1) Thread.Sleep(200);
            } while (accounting.ActiveProcesses > 1); // Only this launcher remains.
            return app.ExitCode;
        }
    }
}
