import { t } from './i18n';
/**
 * Mensaje de estado durante el aprovisionamiento.
 * - Home: mensaje directo a la consola.
 * - Cloud: indica que se está levantando un servidor Azure; el blade puede
 *   tardar 20-60 s (o más con cola), así que avisa hasta un minuto.
 */
export function provisioningMessage(kind: "home" | "cloud", name: string): string {
  return kind === "cloud"
    ? t('cloudProvision',{name:name})
    : t('homeProvision',{name:name});
}
