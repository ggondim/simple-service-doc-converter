import { exec as execCb } from 'child_process';
import { writeFile, readFile } from 'fs/promises';
import { promisify } from 'util';
import FileTemp from '../common/class/FileTemp';
import pLimit from 'p-limit';

const exec = promisify(execCb);

const limit = pLimit(parseInt(process.env.CONCURRENCY_LIMIT || '5', 10));

export type ConvertResult = { convertedFile: Buffer } | { stdout?: string; stderr?: string };

export const convertFile = async (document: Buffer, fromExt: string, toExt: string): Promise<ConvertResult> => {
  return limit(async () => {
    const temp = new FileTemp();
    await temp.ready();

    try {
      const inputPath = `${temp.filePath}.${fromExt}`;
      const outputPath = `${temp.filePath}.${toExt}`;

      await writeFile(inputPath, document);

      const command = `soffice --headless --convert-to ${toExt} ${inputPath} --outdir ${temp.tempDir}`;

      const { stdout, stderr } = await exec(command);

      // Não tratamos stderr como erro imediato — muitas vezes o LibreOffice emite
      // warnings em stderr (ex: javaldx) mas ainda gera o arquivo convertido.
      try {
        const convertedFile = await readFile(outputPath);
        return { convertedFile };
      } catch {
        // Arquivo não gerado — retornar detalhes para diagnóstico
        return { stderr: typeof stderr === 'string' ? stderr : String(stderr), stdout };
      }
    } finally {
      await temp.cleanFileOnTmpFolder();
    }
  });
};
