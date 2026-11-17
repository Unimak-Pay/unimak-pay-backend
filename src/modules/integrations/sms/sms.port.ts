export const SMS_SENDER = Symbol('SmsSender');

export interface SmsSender {
  send(phone: string, text: string): Promise<void>;
}
