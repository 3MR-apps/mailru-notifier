# Политика конфиденциальности

Расширение «3MR — уведомления о почте для Mail.ru». Неофициальное, не связано с VK и Mail.ru.

Действует с 10 октября 2026 года.

## Коротко

Расширение работает только в вашем браузере. Разработчик не получает ваших данных: у расширения нет своего сервера, аналитики и рекламы. Расширение обращается только к серверам mail.ru — чтобы показать ваши непрочитанные письма и по вашей команде отметить письмо прочитанным или удалить его.

## Какие данные расширение использует

Расширение работает через вход в Mail.ru, который уже есть в вашем браузере. Пароль оно не спрашивает и не видит.

Из ответов mail.ru расширение использует и сохраняет только:

- адреса ваших почтовых ящиков;
- названия папок и число непрочитанных писем в них;
- по каждому непрочитанному письму: имя и адрес отправителя, тему, первые строки текста (не больше 500 символов), дату, отметку о вложении и ссылку на аватар отправителя.

Полный текст писем и вложения расширение не загружает.

## Где хранятся данные

В профиле Chrome на вашем компьютере:

- до 100 последних непрочитанных писем на каждый ящик с полями из списка выше — чтобы показать их в окне расширения и не присылать уведомления о старых письмах после перезапуска браузера. Письмо исчезает из списка, когда вы его прочитали или удалили;
- названия папок с числом непрочитанных;
- номера писем, которые вы недавно открыли, прочитали или удалили, — чтобы не уведомлять о них повторно; при очередной проверке почты удаляются номера старше двух интервалов проверки (от 10 минут до 2 часов);
- настройки, в том числе режим уведомлений, порядок и свёрнутость для каждого ящика — по его адресу.

Служебный ключ доступа к почте хранится только в оперативной памяти браузера. Он удаляется, когда вы закрываете Chrome, обновляете или отключаете расширение.

Если уведомления включены, отправитель, тема и начало письма показываются системными уведомлениями Windows или другой операционной системы. Система может хранить их в своей истории уведомлений, пока вы её не очистите.

## Куда отправляются данные

- Запросы с вашим входом расширение отправляет только на четыре адреса mail.ru: `portal.mail.ru`, `auth.mail.ru`, `e.mail.ru`, `mailru-checker-api.e.mail.ru`.
- Аватары отправителей загружаются только с серверов mail.ru (`*.mail.ru`, `*.imgsmail.ru`). Ссылки на другие сайты расширение не открывает и показывает вместо аватара первую букву имени.
- Никому больше расширение данные не передаёт, не продаёт и не использует для рекламы или оценки кредитоспособности.

## Как удалить данные

- Кнопка «Сбросить состояние» на странице настроек удаляет сохранённый список писем и ключ доступа, после чего расширение сразу проверяет почту заново. Настройки, порядок и свёрнутость ящиков сохраняются.
- Чтобы удалить всё, удалите расширение: Chrome сотрёт все его данные. Историю системных уведомлений очищает сама операционная система.

## Изменения политики

Если расширение начнёт обрабатывать данные иначе, этот документ и дата в его начале будут обновлены. История изменений видна в репозитории.

## Связь

Вопросы о конфиденциальности задавайте в разделе [Issues](https://github.com/3MR-apps/mailru-notifier/issues) репозитория.

---

# Privacy Policy

"3MR — уведомления о почте для Mail.ru" (3MR — Mail.ru email notifications). Unofficial; not affiliated with VK or Mail.ru.

Effective October 10, 2026.

## Summary

The extension runs only in your browser. The developer receives none of your data: there is no developer server, no analytics and no ads. The extension talks only to mail.ru servers — to show your unread email and, when you ask, to mark a message as read or delete it.

## Data the extension uses

The extension works through your existing Mail.ru sign-in in the browser. It never asks for or sees your password.

From mail.ru responses it uses and stores only:

- the addresses of your mailboxes;
- folder names and their unread counts;
- for each unread message: sender name and address, subject, the first lines of text (up to 500 characters), date, attachment flag and a link to the sender's avatar.

It does not download full message bodies or attachments.

## Where data is stored

In your Chrome profile on your computer:

- up to 100 recent unread messages per mailbox with the fields above — to show them in the extension window and to avoid notifying about old messages after a browser restart. A message leaves the list once you read or delete it;
- folder names with unread counts;
- IDs of messages you recently opened, read or deleted — to avoid repeat notifications; on each mail check, IDs older than two check intervals (10 minutes to 2 hours) are removed;
- settings, including the notification mode, order and collapsed state of each mailbox — keyed by its address.

The mail access key is kept only in browser memory. It is deleted when you close Chrome, update or disable the extension.

If notifications are enabled, the sender, subject and beginning of a message are shown as Windows (or other operating system) notifications. The system may keep them in its notification history until you clear it.

## Where data is sent

- Requests with your sign-in go only to four mail.ru hosts: `portal.mail.ru`, `auth.mail.ru`, `e.mail.ru`, `mailru-checker-api.e.mail.ru`.
- Sender avatars are loaded only from mail.ru servers (`*.mail.ru`, `*.imgsmail.ru`). Links to other sites are ignored, and the first letter of the name is shown instead.
- Data is not shared with anyone else, not sold, and not used for advertising or creditworthiness.

## Deleting data

- The "Reset state" button on the settings page deletes the stored message list and the access key; the extension then checks mail again right away. Settings, mailbox order and collapsed state are kept.
- To delete everything, uninstall the extension: Chrome erases all its data. Notification history is cleared by the operating system itself.

## Changes

If data handling changes, this document and its date will be updated. The change history is visible in the repository.

## Contact

Privacy questions: [Issues](https://github.com/3MR-apps/mailru-notifier/issues) in the repository.
