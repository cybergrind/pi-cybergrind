PI_DIR := $(HOME)/.pi/agent
LINK   := $(PI_DIR)/keybindings.json
TARGET := $(CURDIR)/keybindings.json

.PHONY: install uninstall status

install:
	@mkdir -p $(PI_DIR)
	@if [ -L $(LINK) ]; then \
		echo "==> $(LINK) already a symlink → $$(readlink $(LINK))"; \
		echo "==> relinking to $(TARGET)"; \
		rm $(LINK); \
	elif [ -e $(LINK) ]; then \
		echo "==> $(LINK) is a real file; backing up to $(LINK).bak"; \
		mv $(LINK) $(LINK).bak; \
	fi
	@ln -s $(TARGET) $(LINK)
	@echo "==> linked $(LINK) → $(TARGET)"
	@echo
	@echo "Next: register this package with pi (one-time):"
	@echo "  pi install $(CURDIR)"
	@echo "Then: /reload in a running pi session."

uninstall:
	@if [ -L $(LINK) ] && [ "$$(readlink $(LINK))" = "$(TARGET)" ]; then \
		rm $(LINK); \
		echo "==> removed $(LINK)"; \
		if [ -e $(LINK).bak ]; then \
			mv $(LINK).bak $(LINK); \
			echo "==> restored backup $(LINK).bak → $(LINK)"; \
		fi; \
	else \
		echo "==> $(LINK) is not our symlink; not touching it"; \
	fi

status:
	@echo "TARGET: $(TARGET)"
	@echo "LINK:   $(LINK)"
	@if [ -L $(LINK) ]; then \
		echo "STATE:  symlink → $$(readlink $(LINK))"; \
	elif [ -e $(LINK) ]; then \
		echo "STATE:  real file ($$(stat -c %s $(LINK)) bytes)"; \
	else \
		echo "STATE:  not present"; \
	fi
