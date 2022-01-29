import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { UsersModule } from "./users/users.module";
import { UsersService } from "./users/users.service";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  // get services to run
  const usersService = app.select(UsersModule).get(UsersService);

  // setup service dependencies
  await usersService.init();

  // and run services
  usersService.run();
}

bootstrap();
