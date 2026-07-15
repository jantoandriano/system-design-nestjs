import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(() => {
    appController = new AppController(new AppService());
  });

  it('returns instance info', () => {
    const info = appController.getInfo();
    expect(info.message).toBe('System Design NestJS demo');
    expect(info).toHaveProperty('hostname');
    expect(info).toHaveProperty('timestamp');
  });
});
