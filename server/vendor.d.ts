declare module "soda-decrypt" {
  export function decryptSodaAudio(options: {
    playAuth?: string;
    key?: string;
    file: string;
    out: string;
  }): Promise<unknown>;
}
