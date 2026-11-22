using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Profiling;

namespace Spatial.Native
{
    [Serializable]public sealed class MetricSnapshot
    {
        public bool timingAvailable;public int samples;public double cpuP95Ms,gpuP95Ms;public long allocatedBytes;
    }
    public sealed class NativeMetrics
    {
        private readonly Queue<double> cpu=new Queue<double>(),gpu=new Queue<double>();private readonly FrameTiming[] timing=new FrameTiming[1];private ulong lastTimestamp;
        public void Capture()
        {
            FrameTimingManager.CaptureFrameTimings();
            if(FrameTimingManager.GetLatestTimings(1,timing)==0)return;
            var frame=timing[0];if(frame.cpuFrameTime<=0||frame.gpuFrameTime<=0||(frame.frameStartTimestamp!=0&&frame.frameStartTimestamp==lastTimestamp))return;
            lastTimestamp=frame.frameStartTimestamp;
            Record(frame.cpuFrameTime,frame.gpuFrameTime);
        }
        public void Record(double cpuMs,double gpuMs)
        {
            if(double.IsNaN(cpuMs)||double.IsInfinity(cpuMs)||double.IsNaN(gpuMs)||double.IsInfinity(gpuMs)||cpuMs<=0||gpuMs<=0)return;
            cpu.Enqueue(cpuMs);gpu.Enqueue(gpuMs);while(cpu.Count>2200){cpu.Dequeue();gpu.Dequeue();}
        }
        public MetricSnapshot Snapshot()=>new MetricSnapshot{timingAvailable=cpu.Count>0,samples=cpu.Count,cpuP95Ms=Percentile(cpu),gpuP95Ms=Percentile(gpu),allocatedBytes=Profiler.GetTotalAllocatedMemoryLong()};
        private static double Percentile(Queue<double> values){if(values.Count==0)return 0;var sorted=values.ToArray();Array.Sort(sorted);return sorted[Math.Max(0,(int)Math.Ceiling(sorted.Length*.95)-1)];}
    }
}
