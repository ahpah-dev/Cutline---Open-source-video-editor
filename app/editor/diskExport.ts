import { exportProject } from './media';
import type { Project } from './model';
import type { ExportOptions } from './offlineExport';

/** Save-dialog authorization and opaque native session; no whole-file IPC copy. */
export async function exportToDisk(project:Project,options:ExportOptions,name:string) {
  const desktop=window.cutlineDesktop;
  if (!desktop?.beginVideoExport) throw new Error('Update the Windows app to use disk-backed export.');
  options.signal.throwIfAborted();
  options.onProgress(0,'Choose an export destination');
  const destination=await desktop.beginVideoExport(name);
  if (destination.canceled) return null;
  if (!destination.token) throw new Error('Could not open the export destination.');
  const token=destination.token;
  try {
    options.signal.throwIfAborted();
    const size=await exportProject(project,{...options,sink:{async write(data,position) {
      // StreamTarget normally emits <=1 MiB, but split defensively. Await each
      // native acknowledgement to propagate slow-disk backpressure to encoding.
      for(let offset=0;offset<data.byteLength;offset+=1024*1024) {
        options.signal.throwIfAborted();
        await desktop.writeVideoExport(token,position+offset,data.slice(offset,offset+1024*1024).buffer);
      }
    }}});
    options.signal.throwIfAborted();
    options.onProgress(1,'Saving finished video — please wait');
    // Once atomic commit starts, cancellation cannot roll back a completed rename.
    return await desktop.finishVideoExport(token,size);
  } catch(failure) {
    try { await desktop.cancelVideoExport(token); }
    catch(error) {
      if (!(error as Error).message.includes('session expired'))
        throw new Error(`${failure instanceof Error ? failure.message : 'Export cancelled'}. Temporary export cleanup failed: ${(error as Error).message}. Check ${destination.filePath}’s folder for the .cutline-export partial file. Your existing destination was not replaced.`);
    }
    throw failure;
  }
}
